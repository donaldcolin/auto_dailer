const { withAppBuildGradle } = require('expo/config-plugins');

// Signs release APKs with the key in ~/.dialer-signing (never in git). Every update for HR/sales phones must use
// this same key, or Android refuses to install it over the old app. A Mac without the key can't build a release.
const SIGNING = `
        release {
            def props = new Properties()
            def f = new File(System.getProperty("user.home"), ".dialer-signing/release.properties")
            if (!f.exists()) throw new GradleException("Missing \${f}: copy the dialer release key there (see CLAUDE.md)")
            f.withInputStream { props.load(it) }
            storeFile file(props.storeFile)
            storePassword props.storePassword
            keyAlias props.keyAlias
            keyPassword props.keyPassword
        }`;

module.exports = (config) =>
  withAppBuildGradle(config, (cfg) => {
    let g = cfg.modResults.contents;
    if (!g.includes('.dialer-signing')) {
      g = g.replace(/signingConfigs \{/, `signingConfigs {${SIGNING}`);
      // the release buildType's line comes after "release {" inside buildTypes
      g = g.replace(/(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/, '$1signingConfig signingConfigs.release');
    }
    cfg.modResults.contents = g;
    return cfg;
  });
