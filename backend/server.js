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

if (require.main === module) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`Dialer backend on :${port}`));
}

module.exports = app;
