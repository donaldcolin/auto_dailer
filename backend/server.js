require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true }));
app.use(express.json());
// Slow requests, to see where time goes between calls (LSQ waits are logged by config/lsq.js).
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (ms > 2000) console.log(`[slow] ${req.method} ${req.baseUrl}${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
// The newest APK (Railway env). Phones on an older build show "Update available"; /download is the link new users get.
app.get('/api/app-version', (req, res) => res.json({ build: Number(process.env.APK_BUILD) || 0, url: process.env.APK_URL || null }));
app.get('/download', (req, res) => (process.env.APK_URL ? res.redirect(process.env.APK_URL) : res.status(404).send('No APK yet')));
app.use('/api/me', require('./routes/me'));
app.use('/api/setup', require('./routes/setup'));
app.use('/api/lists', require('./routes/lists'));
app.use('/api/team', require('./routes/team'));
app.use('/api/rules', require('./routes/rules'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/disposition', require('./routes/disposition'));
app.use('/api/activity-form', require('./routes/activity'));
app.use('/api/lead', require('./routes/lead'));

// Express 5 sends rejected async handlers here.
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Server error' });
});

if (require.main === module) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`Dialer backend on :${port}`);
    require('./services/views').warm();
  });
}

module.exports = app;
