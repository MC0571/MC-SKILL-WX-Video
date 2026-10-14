'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const directory = __dirname;
const screenshotNames = ['screenshot-parse', 'screenshot-agent', 'screenshot-privacy'];
const exportSpecifications = [
  ...screenshotNames.map((name) => ({ name, width: 1280, height: 800 })),
  { name: 'promo-small', width: 440, height: 280 },
  { name: 'promo-marquee', width: 1400, height: 560 },
];

async function inlineLocalImages(svg) {
  const imageHrefs = [...svg.matchAll(/<image\b[^>]*\bhref="([^"]+)"/g)]
    .map((match) => match[1]);
  let result = svg;

  for (const href of imageHrefs) {
    if (href.startsWith('data:')) continue;

    const assetPath = path.resolve(directory, href);
    const extension = path.extname(assetPath).toLowerCase();
    const mimeType = {
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    }[extension];
    assert.ok(mimeType, `Unsupported image type in ${href}`);
    const contents = await fs.readFile(assetPath);
    result = result.replaceAll(`href="${href}"`, `href="data:${mimeType};base64,${contents.toString('base64')}"`);
  }

  return result;
}

async function exportSvg(name) {
  const source = path.join(directory, `${name}.svg`);
  const destination = path.join(directory, `${name}.png`);
  const specification = exportSpecifications.find((entry) => entry.name === name);
  const svg = await fs.readFile(source, 'utf8');
  const output = await sharp(Buffer.from(await inlineLocalImages(svg))).png().toFile(destination);
  assert.equal(output.width, specification.width, `${name}.png width`);
  assert.equal(output.height, specification.height, `${name}.png height`);

  const statistics = await sharp(destination).stats();
  assert.equal(statistics.isOpaque, true, `${name}.png must be opaque`);
  console.log(`${name}.png ${output.width}x${output.height}, opaque`);
}

async function buildContactSheet() {
  const screenshotThumbnails = await Promise.all(screenshotNames.map((name) =>
    sharp(path.join(directory, `${name}.png`))
      .resize(420, 263, { fit: 'contain', background: '#FFFFFF' })
      .png()
      .toBuffer()));
  const smallPromo = await sharp(path.join(directory, 'promo-small.png')).png().toBuffer();
  const marquee = await sharp(path.join(directory, 'promo-marquee.png'))
    .resize(700, 280, { fit: 'fill' })
    .png()
    .toBuffer();

  await sharp({
    create: { width: 1400, height: 600, channels: 4, background: '#FFFFFF' },
  }).composite([
    { input: screenshotThumbnails[0], left: 24, top: 20 },
    { input: screenshotThumbnails[1], left: 490, top: 20 },
    { input: screenshotThumbnails[2], left: 956, top: 20 },
    { input: smallPromo, left: 120, top: 300 },
    { input: marquee, left: 600, top: 300 },
  ]).png().toFile(path.join(directory, 'contact-sheet.png'));
}

async function main() {
  for (const { name } of exportSpecifications) {
    await exportSvg(name);
  }
  await buildContactSheet();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
