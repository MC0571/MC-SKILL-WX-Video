import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

import yaml


SKILL = "weixin-channels-video"
VERSION_FILE = f"skills/{SKILL}/version.json"
HOST = "https://api.skillhub.cn"
DISTRIBUTION_PATHS = [f"skills/{SKILL}", "src", "scripts/build.mjs",
                      "package.json", "package-lock.json", "LICENSE"]


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", value):
        raise ValueError("SkillHub requires a stable three-component SemVer")
    result = tuple(map(int, value.split(".")))
    if max(result) > 65535:
        raise ValueError("Skill version components must be at most 65535")
    return result


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def plan(base, target, manual=False):
    for ref in (base, target):
        if not re.fullmatch(r"[0-9a-f]{40}", ref) or ref == "0" * 40:
            raise ValueError("An existing base and target commit are required")
    current = json.loads(git("show", f"{target}:{VERSION_FILE}"))["version"]
    previous = json.loads(git("show", f"{base}:{VERSION_FILE}"))["version"]
    current_tuple, previous_tuple = version_tuple(current), version_tuple(previous)
    changed = bool(git("diff", "--name-only", base, target, "--", *DISTRIBUTION_PATHS))
    if not manual and changed and current_tuple <= previous_tuple:
        raise ValueError("Skill distribution inputs changed; increment version.json before merging")
    return {"version": current, "release_allowed": str(manual or changed).lower()}


def manual_release():
    if os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
        return False
    if os.environ.get("GITHUB_REF") != "refs/heads/main" or os.environ.get("CONFIRM_NO_PENDING_REVIEW") != "true":
        raise ValueError("Manual release requires main and confirmation of no pending submission")
    return True


def bundle():
    source = Path("dist") / SKILL
    version = json.loads(source.joinpath("version.json").read_text())["version"]
    version_tuple(version)
    runtime = json.loads(source.joinpath("runtime.json").read_text())
    if runtime["version"] != version:
        raise ValueError("Built runtime version does not match version.json")
    for name in ("scripts/run.mjs", "scripts/cli.mjs", "scripts/native-host.mjs", "LICENSE"):
        if not source.joinpath(name).is_file():
            raise ValueError(f"Incomplete standalone Skill: {name}")
    if any(path.is_symlink() for path in source.rglob("*")):
        raise ValueError("Skill bundle must not contain symbolic links")
    text = source.joinpath("SKILL.md").read_text(encoding="utf-8")
    match = re.fullmatch(r"---\n(.*?)\n---\n(.*)", text, re.DOTALL)
    if not match:
        raise ValueError("SKILL.md must start with YAML frontmatter")
    metadata = yaml.safe_load(match[1])
    if not isinstance(metadata, dict) or metadata.get("name") != SKILL or not metadata.get("description"):
        raise ValueError("Invalid Skill name or description")
    title = re.search(r"^# (.+)$", match[2], re.MULTILINE)
    if not title:
        raise ValueError("SKILL.md needs a display title")
    metadata.update(slug=SKILL, version=version, displayName=title[1])
    output = Path("dist/skillhub") / SKILL
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(source, output)
    output.joinpath("SKILL.md").write_text(
        "---\n" + yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False) + "---\n" + match[2],
        encoding="utf-8",
    )


def check_identity(payload, expected):
    user = payload.get("user", {})
    if not expected or str(user.get("handle", "")).casefold() != expected.casefold():
        raise ValueError("SkillHub token handle does not match SKILLHUB_PUBLISHER")


def public_state(payload, publisher, namespace, version):
    if payload.get("owner", {}).get("handle", "").casefold() != publisher.casefold():
        raise ValueError("SkillHub target belongs to another publisher")
    public_namespace = payload.get("namespace", {})
    if public_namespace.get("handle", "").casefold() != namespace.casefold() or public_namespace.get("publicSlug") != SKILL:
        raise ValueError("SkillHub target namespace or slug does not match")
    remote = version_tuple(payload.get("latestVersion", {}).get("version"))
    local = version_tuple(version)
    if remote > local:
        raise ValueError("SkillHub already has a newer version")
    return "skip" if remote == local else "publish"


def check_target():
    publisher = os.environ["SKILLHUB_PUBLISHER"]
    namespace = os.environ["SKILLHUB_NAMESPACE"]
    if not publisher or not namespace:
        raise ValueError("SKILLHUB_PUBLISHER and SKILLHUB_NAMESPACE are required")
    url = HOST + "/api/v1/skills/resolve?" + urlencode({"coordinate": f"@{namespace}/{SKILL}"})
    try:
        with urlopen(url, timeout=30) as response:
            payload = json.load(response)
    except HTTPError as error:
        if error.code != 404:
            raise
        # Public 404 cannot reveal pending review; never blindly replay a failed submission.
        if os.environ.get("GITHUB_RUN_ATTEMPT") != "1" or not (
            os.environ.get("GITHUB_EVENT_NAME") == "push" or manual_release()
        ):
            raise ValueError("SkillHub status is not public; check pending submissions before retrying") from None
        return "publish"
    return public_state(payload, publisher, namespace, os.environ["SKILL_VERSION"])


def publication_result(payload):
    if payload.get("success") is False:
        status = payload.get("status")
        if type(status) is not int or not 400 <= status <= 599:
            raise ValueError("SkillHub returned an invalid HTTP error status")
        category = {401: "authentication_failed", 403: "permission_denied",
                    409: "conflict", 429: "rate_limited"}.get(status, "http_error")
        return {"status": "failed", "httpStatus": status, "error": category}
    result = {key: payload[key] for key in ("skillId", "status", "publicUrl") if key in payload}
    if not isinstance(result.get("status"), str):
        raise ValueError("SkillHub did not return a publication status; check dashboard before retrying")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["plan", "bundle", "identity", "target", "result"])
    parser.add_argument("--base")
    parser.add_argument("--target")
    args = parser.parse_args()
    if args.command == "plan":
        result = plan(args.base or "", args.target or "", manual=manual_release())
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write("".join(f"{key}={value}\n" for key, value in result.items()))
        print(json.dumps(result))
    elif args.command == "bundle":
        bundle()
    elif args.command == "identity":
        check_identity(json.load(sys.stdin), os.environ["SKILLHUB_PUBLISHER"])
    elif args.command == "target":
        print(check_target())
    elif args.command == "result":
        print(json.dumps(publication_result(json.load(sys.stdin)), ensure_ascii=False))


if __name__ == "__main__":
    main()
