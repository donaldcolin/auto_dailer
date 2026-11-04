require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/me', require('./routes/me'));
app.use('/api/lists', require('./routes/lists'));
app.use('/api/team', require('./routes/team'));
app.use('/api/rules', require('./routes/rules'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/disposition', require('./routes/disposition'));
app.use('/api/activity-form', require('./routes/activity'));

// Express 5 sends rejected async handlers here.
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Server error' });
});

if (require.main === module) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`Dialer backend on :${port}`));
}

module.exports = app;
