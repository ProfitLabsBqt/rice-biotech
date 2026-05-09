const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI;

let db;

// ── Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'biotech-fuels-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──
const aw = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function oid(id) {
  try { return new ObjectId(id); } catch { return null; }
}

function auth(right) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (right && !req.session.user.rights.includes(right) && !req.session.user.rights.includes('admin'))
      return res.status(403).json({ error: 'No permission' });
    next();
  };
}

async function nextCounter(name) {
  const result = await db.collection('meta').findOneAndUpdate(
    { _id: name },
    { $inc: { val: 1 } },
    { returnDocument: 'after' }
  );
  return result.val;
}

async function seedAdmin() {
  const hash = bcrypt.hashSync('admin123', 10);
  await db.collection('users').deleteMany({ username: 'admin' });
  await db.collection('users').insertOne({
    username: 'admin', password: hash, name: 'Administrator', role: 'admin',
    rights: ['dashboard','po','weighbridge','invoice','lab','payment','admin'],
    createdAt: new Date()
  });
  console.log('Admin seeded OK');
}

async function initCounters() {
  await db.collection('meta').updateOne({ _id: 'po' },  { $setOnInsert: { val: 1000 } }, { upsert: true });
  await db.collection('meta').updateOne({ _id: 'grn' }, { $setOnInsert: { val: 200  } }, { upsert: true });
}

// ── AUTH ──
app.get('/api/test', aw(async (req, res) => {
  const users = await db.collection('users').find({}, { projection: { password: 0 } }).toArray();
  res.json({ ok: true, users });
}));

app.post('/api/login', aw(async (req, res) => {
  const { username, password } = req.body;
  const user = await db.collection('users').findOne({ username });
  if (!user) return res.json({ ok: false, error: 'User not found: ' + username });
  if (!bcrypt.compareSync(password, user.password)) return res.json({ ok: false, error: 'Wrong password' });
  req.session.user = { id: user._id.toString(), username: user.username, name: user.name, role: user.role, rights: user.rights };
  res.json({ ok: true, user: req.session.user });
}));

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user });
});

// ── USERS ──
app.get('/api/users', auth('admin'), aw(async (req, res) => {
  const users = await db.collection('users').find({}, { projection: { password: 0 } }).toArray();
  res.json(users);
}));

app.post('/api/users', auth('admin'), aw(async (req, res) => {
  const { username, password, name, rights } = req.body;
  if (!username || !password || !name) return res.json({ ok: false, error: 'Missing fields' });
  if (await db.collection('users').findOne({ username })) return res.json({ ok: false, error: 'Username taken' });
  await db.collection('users').insertOne({
    username, password: bcrypt.hashSync(password, 10), name, rights: rights || [], createdAt: new Date()
  });
  res.json({ ok: true });
}));

app.put('/api/users/:id', auth('admin'), aw(async (req, res) => {
  const { name, rights, password } = req.body;
  const update = { name, rights };
  if (password) update.password = bcrypt.hashSync(password, 10);
  await db.collection('users').updateOne({ _id: oid(req.params.id) }, { $set: update });
  res.json({ ok: true });
}));

app.delete('/api/users/:id', auth('admin'), aw(async (req, res) => {
  await db.collection('users').deleteOne({ _id: oid(req.params.id) });
  res.json({ ok: true });
}));

// ── POs ──
app.get('/api/pos', auth('dashboard'), aw(async (req, res) => {
  res.json(await db.collection('pos').find({}).sort({ createdAt: -1 }).toArray());
}));

app.post('/api/pos', auth('po'), aw(async (req, res) => {
  const num = await nextCounter('po');
  const po = { poNumber: 'PO-'+num, ...req.body, receivedQtyMT: 0, status: 'Active', createdBy: req.session.user.username, createdAt: new Date() };
  const { insertedId } = await db.collection('pos').insertOne(po);
  res.json({ ok: true, po: { ...po, _id: insertedId } });
}));

app.put('/api/pos/:id', auth('po'), aw(async (req, res) => {
  await db.collection('pos').updateOne({ _id: oid(req.params.id) }, { $set: req.body });
  res.json({ ok: true });
}));

// ── WEIGHBRIDGE ──
app.get('/api/wb', auth('dashboard'), aw(async (req, res) => {
  res.json(await db.collection('wb').find({}).sort({ createdAt: -1 }).toArray());
}));

app.post('/api/wb', auth('weighbridge'), aw(async (req, res) => {
  const entry = { ...req.body, labDone: false, createdBy: req.session.user.username, createdAt: new Date() };
  const { insertedId } = await db.collection('wb').insertOne(entry);
  res.json({ ok: true, entry: { ...entry, _id: insertedId } });
}));

app.put('/api/wb/:id', auth('invoice'), aw(async (req, res) => {
  await db.collection('wb').updateOne({ _id: oid(req.params.id) }, { $set: req.body });
  res.json({ ok: true });
}));

// ── GRNs ──
app.get('/api/grns', auth('dashboard'), aw(async (req, res) => {
  res.json(await db.collection('grns').find({}).sort({ createdAt: -1 }).toArray());
}));

app.post('/api/grns', auth('lab'), aw(async (req, res) => {
  const num = await nextCounter('grn');
  const grn = { grnNumber: 'GRN-'+num, ...req.body, status: 'Pending Acceptance', createdBy: req.session.user.username, createdAt: new Date() };
  const { insertedId } = await db.collection('grns').insertOne(grn);
  await db.collection('wb').updateOne({ _id: oid(req.body.wbId) }, { $set: { labDone: true } });
  const po = await db.collection('pos').findOne({ poNumber: req.body.poId });
  if (po) {
    const newRecv = +((po.receivedQtyMT || 0) + req.body.receivedQ / 10).toFixed(2);
    await db.collection('pos').updateOne({ poNumber: req.body.poId }, { $set: { receivedQtyMT: newRecv } });
  }
  res.json({ ok: true, grn: { ...grn, _id: insertedId } });
}));

// ── DASHBOARD ──
app.get('/api/dashboard', auth('dashboard'), aw(async (req, res) => {
  const [pos, wbs, grns] = await Promise.all([
    db.collection('pos').find({}).toArray(),
    db.collection('wb').find({}).toArray(),
    db.collection('grns').find({}).toArray()
  ]);
  res.json({ pos, wbs, grns });
}));

// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ── Serve SPA ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ──
async function start() {
  if (!MONGO_URI) { console.error('MONGODB_URI not set'); process.exit(1); }
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('biotech');
  console.log('MongoDB connected');
  await initCounters();
  await seedAdmin();
  app.listen(PORT, () => console.log('Biotech Fuels running on port', PORT));
}

start().catch(err => { console.error('Startup error:', err); process.exit(1); });
