const { withAndroidManifest } = require('expo/config-plugins');

// Android 10 has no "All files access"; this flag lets the storage permission reach the recording folders there.
module.exports = (config) =>
  withAndroidManifest(config, (cfg) => {
    cfg.modResults.manifest.application[0].$['android:requestLegacyExternalStorage'] = 'true';
    return cfg;
  });
