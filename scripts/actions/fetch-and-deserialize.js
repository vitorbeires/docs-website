'use strict';
const AdmZip = require('adm-zip');
const vfile = require('vfile');
const { writeSync } = require('to-vfile');
const path = require('path');
const fse = require('fs-extra');

const fetch = require('node-fetch');

const deserializedHtml = require('./deserialize-html');
const createDirectories = require('../utils/migrate/create-directories');
const { getAccessToken } = require('./utils/vendor-request');

const localesMap = {
  'ja-JP': 'jp',
};

const projectId = process.env.TRANSLATION_VENDOR_PROJECT;

/**
 * Method which writes translated content to the 'src/content/i18n' path, and copies images for translated files.
 * @param {vfile.VFile[]} vfiles
 */
const writeFilesSync = (vfiles) => {
  const copiedDirectories = {};

  vfiles.forEach((file) => {
    writeSync(file, 'utf-8');

    const imageDirectory = `${path.dirname(
      file.path.substring(file.path.indexOf('/docs/'))
    )}/images`;

    /*
      Check to see:
        1. have we already copied this image directory for a different file (with the same parent path)?
        2. does the image directory exist?
    */
    if (
      !(imageDirectory in copiedDirectories) &&
      fse.existsSync(path.join('src/content/', imageDirectory))
    ) {
      // sync 'src/content/docs/.../images' to 'src/i18n/content/.../docs/.../images'
      fse.copySync(
        path.join('src/content/', imageDirectory),
        path.join(path.dirname(file.path), '/images'),
        {
          overwrite: true,
        }
      );
      copiedDirectories[imageDirectory] = true;
    }
  });
};

const fetchTranslatedFilesZip = async (fileUris, locale) => {
  const fileUriStr = fileUris.reduce((str, uri) => {
    return str.concat(`&fileUris[]=${encodeURIComponent(uri)}`);
  }, '');

  const localeIdStr = `localeIds[]=${locale}`;

  return fetch(
    `https://api.smartling.com/files-api/v2/projects/${projectId}/files/zip?${localeIdStr}${fileUriStr}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
      },
    }
  );
};

const fetchAndDeserialize = async ({ locale, fileUris }) => {
  const response = await fetchTranslatedFilesZip(fileUris, locale);

  console.log(response.status);
  console.log(JSON.stringify(response));

  const buffer = await response.buffer();

  const zip = new AdmZip(buffer);
  const zipEntries = zip.getEntries();

  const translatedHtml = zipEntries.map((entry) => {
    const filepath = entry.entryName.replace(`${locale}/src/content/docs`, '');
    const slug = filepath.replace(`.mdx`, '');
    return {
      path: slug,
      html: zip.readAsText(entry, 'utf8'),
    };
  });

  try {
    const deserializedMdx = await Promise.all(
      translatedHtml.map(async ({ path, html }) => {
        console.log(`[*] Deserializing ${path}`);
        return {
          path: `src/i18n/content/${localesMap[locale]}/docs/${path}`,
          mdx: await deserializedHtml(html),
        };
      })
    );

    const files = deserializedMdx.map(
      ({ path, mdx }) =>
        vfile({
          contents: mdx,
          path,
          extname: '.mdx',
        }),
      'utf-8'
    );

    createDirectories(files);
    writeFilesSync(files);
  } catch (ex) {
    console.log(ex);
  }
};

const batchedFetchAndDeserialize = async ({ locale, fileUris }) => {
  const batchSizeLimit = 50;
  let batchToSend = [];

  for (let i = 0; i < fileUris.length; i++) {
    batchToSend.push(fileUris[i]);

    if (batchToSend.length === batchSizeLimit) {
      // send the request, reset the count & array
      console.log('Sending full batch');

      await fetchAndDeserialize({ locale, fileUris: batchToSend });
      batchToSend = [];
    }
  }

  // cleanup the last batch
  if (batchToSend.length != 0) {
    console.log(`Sending last batch of size ${batchToSend.length}`);
    await fetchAndDeserialize({ locale, fileUris: batchToSend });
  }
};

module.exports = {
  writeFilesSync,
  fetchAndDeserialize,
  batchedFetchAndDeserialize,
};
