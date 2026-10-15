import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import yaml


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release", ROOT / "scripts/skillhub-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class SkillHubReleaseTest(unittest.TestCase):
    def test_stable_versions_are_compared_numerically(self):
        self.assertGreater(release.version_tuple("0.2.10"), release.version_tuple("0.2.9"))
        for value in (None, "1", "1.2", "01.2.3", "1.2.3.4", "1.2.3-beta", "65536.0.0"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.version_tuple(value)

    def test_changed_inputs_require_a_strict_version_increment(self):
        for current, previous, changed, allowed in (
            ("0.2.5", "0.2.4", "scripts/cli.mjs", "true"),
            ("0.2.4", "0.2.4", "", "false"),
            ("0.2.4", "0.2.4", "src/native-host.mjs", None),
            ("0.2.3", "0.2.4", "version.json", None),
        ):
            with self.subTest(current=current, changed=changed), patch.object(release, "git", side_effect=[
                json.dumps({"version": current}), json.dumps({"version": previous}), changed,
            ]):
                if allowed is None:
                    with self.assertRaises(ValueError):
                        release.plan("a" * 40, "b" * 40)
                else:
                    self.assertEqual(release.plan("a" * 40, "b" * 40)["release_allowed"], allowed)
        with self.assertRaises(ValueError):
            release.plan("0" * 40, "b" * 40)

    def test_bundle_keeps_source_unchanged_and_contains_standalone_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = Path.cwd()
            try:
                os.chdir(directory)
                source = Path("dist/weixin-channels-video")
                source.joinpath("scripts").mkdir(parents=True)
                original = "---\nname: weixin-channels-video\ndescription: '描述：保留'\n---\n\n# 视频号解析与下载\n\n正文\n"
                source.joinpath("SKILL.md").write_text(original)
                for name in ("version.json", "runtime.json"):
                    source.joinpath(name).write_text('{"version":"0.2.4"}')
                for name in ("scripts/run.mjs", "scripts/cli.mjs", "scripts/native-host.mjs", "LICENSE"):
                    source.joinpath(name).write_text("standalone")
                release.bundle()
                output = Path("dist/skillhub/weixin-channels-video")
                frontmatter = yaml.safe_load(output.joinpath("SKILL.md").read_text().split("---")[1])
                self.assertEqual(frontmatter["version"], "0.2.4")
                self.assertEqual(frontmatter["displayName"], "视频号解析与下载")
                self.assertEqual(frontmatter["description"], "描述：保留")
                self.assertEqual(frontmatter["slug"], release.SKILL)
                self.assertEqual(output.joinpath("scripts/cli.mjs").read_text(), "standalone")
                self.assertEqual(source.joinpath("SKILL.md").read_text(), original)
                source.joinpath("scripts/native-host.mjs").unlink()
                with self.assertRaisesRegex(ValueError, "Incomplete"):
                    release.bundle()
            finally:
                os.chdir(previous)

    def test_identity_and_scoped_target_must_match(self):
        payload = {"owner": {"handle": "publisher"},
                   "namespace": {"handle": "indiv-mc", "publicSlug": release.SKILL},
                   "latestVersion": {"version": "0.2.4"}}
        release.check_identity({"user": {"handle": "publisher"}}, "publisher")
        with self.assertRaises(ValueError):
            release.check_identity({"user": {"handle": "other"}}, "publisher")
        self.assertEqual(release.public_state(payload, "publisher", "indiv-mc", "0.2.4"), "skip")
        self.assertEqual(release.public_state(payload, "publisher", "indiv-mc", "0.2.5"), "publish")
        for publisher, namespace, version in (("other", "indiv-mc", "0.2.5"),
                                              ("publisher", "wrong", "0.2.5"),
                                              ("publisher", "indiv-mc", "0.2.3")):
            with self.assertRaises(ValueError):
                release.public_state(payload, publisher, namespace, version)

    def test_public_404_does_not_allow_blind_rerun(self):
        with patch.dict(os.environ, SKILLHUB_PUBLISHER="publisher", SKILLHUB_NAMESPACE="indiv-mc"), \
                patch.object(release, "urlopen", side_effect=HTTPError("url", 404, "missing", {}, None)):
            with patch.dict(os.environ, GITHUB_RUN_ATTEMPT="1"):
                self.assertEqual(release.check_target(), "publish")
            with patch.dict(os.environ, GITHUB_RUN_ATTEMPT="2"), self.assertRaises(ValueError):
                release.check_target()
        with patch.dict(os.environ, SKILLHUB_PUBLISHER="publisher", SKILLHUB_NAMESPACE="indiv-mc"), \
                patch.object(release, "urlopen", side_effect=HTTPError("url", 403, "denied", {}, None)), \
                self.assertRaises(HTTPError):
            release.check_target()

    def test_workflow_keeps_credentials_out_of_pr_checks(self):
        workflow = yaml.load((ROOT / ".github/workflows/skillhub-release.yml").read_text(), Loader=yaml.BaseLoader)
        checks = workflow["jobs"]["checks"]
        publish = workflow["jobs"]["publish"]
        self.assertNotIn("secrets.", json.dumps(checks))
        self.assertIn("--dry-run", json.dumps(checks))
        self.assertIn("github.event_name == 'push'", publish["if"])
        self.assertIn("github.ref == 'refs/heads/main'", publish["if"])
        self.assertIn("release_allowed == 'true'", publish["if"])
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        for job in workflow["jobs"].values():
            for step in job["steps"]:
                if "uses" in step:
                    self.assertRegex(step["uses"], r"@[0-9a-f]{40}$")

    def test_only_safe_publication_fields_are_saved(self):
        self.assertEqual(release.publication_result({"skillId": 1, "status": "pending_review", "token": "hidden"}),
                         {"skillId": 1, "status": "pending_review"})
        failure = release.publication_result({"success": False, "status": 409,
                                              "error": "response included sensitive-marker", "body": {"private": "hidden"}})
        self.assertEqual(failure, {"status": "failed", "httpStatus": 409, "error": "conflict"})
        self.assertNotIn("sensitive-marker", json.dumps(failure))
        with self.assertRaises(ValueError):
            release.publication_result({"success": False, "status": "sensitive-marker"})
        with self.assertRaises(ValueError):
            release.publication_result({"success": True})


if __name__ == "__main__":
    unittest.main()
