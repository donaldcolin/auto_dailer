// Uploads the release APK to the public "app" bucket and points backend/.env at it (APK_URL, APK_BUILD).
// Run from backend/: node scripts/upload-apk.js   (uses SUPABASE_URL / SUPABASE_KEY from backend/.env)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const supabase = require('../config/supabase');

const APK = path.join(__dirname, '../../app/android/app/build/outputs/apk/release/app-release.apk');
const BUCKET = 'app';

// apksigner needs Java; this Mac has Homebrew's openjdk@17, which isn't on the default path.
const JDK = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
const env = { ...process.env, ...(!process.env.JAVA_HOME && fs.existsSync(JDK) ? { JAVA_HOME: JDK, PATH: `${JDK}/bin:${process.env.PATH}` } : {}) };

async function main() {
  const tools = path.join(process.env.HOME, 'Library/Android/sdk/build-tools');
  const bt = path.join(tools, fs.readdirSync(tools).sort().pop());
  const badging = execFileSync(path.join(bt, 'aapt2'), ['dump', 'badging', APK]).toString();
  const build = badging.match(/versionCode='(\d+)'/)[1];
  // Only the release key's APK installs over the old app.
  const certs = execFileSync(path.join(bt, 'apksigner'), ['verify', '--print-certs', APK], { env }).toString();
  if (!certs.includes('c8220bf268b065741713f4c4ceb4f713f642c06a3a00053f03fc18be2ccfd374')) throw new Error('APK is not signed with the release key');

  const { error: bucketError } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (bucketError && !/already exists/i.test(bucketError.message)) throw new Error(bucketError.message);

  // A new name per build, so no cache can serve an older APK.
  const name = `dialer-${build}.apk`;
  const { error } = await supabase.storage.from(BUCKET).upload(name, fs.readFileSync(APK), {
    contentType: 'application/vnd.android.package-archive', upsert: true,
  });
  if (error) throw new Error(error.message);
  const url = supabase.storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
  // The backend's /download and "new version ready" read these.
  const envFile = path.join(__dirname, '../.env');
  let text = fs.readFileSync(envFile, 'utf8');
  for (const [k, v] of [['APK_URL', url], ['APK_BUILD', build]]) {
    text = new RegExp(`^${k}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
  }
  fs.writeFileSync(envFile, text);
  console.log(`Uploaded ${name}; backend/.env now has APK_BUILD=${build}.\nRun: pm2 restart dialer-api --update-env`);
}

main().catch(e => { console.error('Upload failed:', e.message); process.exit(1); }); // message only: never the request with keys
