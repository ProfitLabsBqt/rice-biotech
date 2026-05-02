const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Datastore = require('nedb');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Use /tmp — always writable on Render
const dataDir = '/tmp/biotech';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
console.log('Using data dir:', dataDir);

// DBs — no autoload, we control loading manually
const usersDB = new Datastore({ filename: path.join(dataDir, 'users.db') });
const posDB   = new Datastore({ filename: path.join(dataDir, 'pos.db') });
const wbDB    = new Datastore({ filename: path.join(dataDir, 'wb.db') });
const grnDB   = new Datastore({ filename: path.join(dataDir, 'grns.db') });
const metaDB  = new Datastore({ filename: path.join(dataDir, 'meta.db') });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'biotech-fuels-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Load all DBs then seed admin
function loadAllDBs(cb) {
  usersDB.loadDatabase(e1 => {
    if (e1) { console.error('usersDB error:', e1); return; }
    posDB.loadDatabase(e2 => {
      if (e2) { console.error('posDB error:', e2); return; }
      wbDB.loadDatabase(e3 => {
        if (e3) { console.error('wbDB error:', e3); return; }
        grnDB.loadDatabase(e4 => {
          if (e4) { console.error('grnDB error:', e4); return; }
          metaDB.loadDatabase(e5 => {
            if (e5) { console.error('metaDB error:', e5); return; }
            console.log('All DBs loaded');
            cb();
          });
        });
      });
    });
  });
}

function seedAdmin(cb) {
  const hash = bcrypt.hashSync('admin123', 10);
  usersDB.remove({ username: 'admin' }, { multi: true }, (err, n) => {
    console.log('Removed old admin records:', n);
    usersDB.insert({
      username: 'admin',
      password: hash,
      name: 'Administrator',
      role: 'admin',
      rights: ['dashboard','po','weighbridge','lab','payment','admin'],
      createdAt: new Date()
    }, (err2, doc) => {
      if (err2) { console.error('Admin insert failed:', err2); return; }
      console.log('Admin seeded OK, id:', doc._id);
      // Verify immediately
      usersDB.findOne({ username: 'admin' }, (e, u) => {
        console.log('Verify admin exists:', !!u);
        const match = bcrypt.compareSync('admin123', u.password);
        console.log('Verify password match:', match);
        cb();
      });
    });
  });
}

// ── Counters ──
function nextCounter(name, cb) {
  metaDB.findOne({ _id: name }, (err, doc) => {
    const next = doc ? doc.val + 1 : (name === 'po' ? 1001 : 201);
    metaDB.update({ _id: name }, { _id: name, val: next }, { upsert: true }, () => cb(next));
  });
}

// ── Auth middleware ──
function auth(right) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (right && !req.session.user.rights.includes(right) && !req.session.user.rights.includes('admin'))
      return res.status(403).json({ error: 'No permission' });
    next();
  };
}

// ── AUTH ROUTES ──
app.get('/api/test', (req, res) => {
  usersDB.find({}, { password: 0 }, (err, docs) => {
    res.json({ ok: true, users: docs, dataDir });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  console.log('Login attempt:', username);
  usersDB.findOne({ username }, (err, user) => {
    console.log('Found user:', !!user, err);
    if (!user) return res.json({ ok: false, error: 'User not found: ' + username });
    const match = bcrypt.compareSync(password, user.password);
    console.log('Password match:', match);
    if (!match) return res.json({ ok: false, error: 'Wrong password' });
    req.session.user = { id: user._id, username: user.username, name: user.name, role: user.role, rights: user.rights };
    res.json({ ok: true, user: req.session.user });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user });
});

// ── ADMIN — USERS ──
app.get('/api/users', auth('admin'), (req, res) => {
  usersDB.find({}, { password: 0 }, (err, docs) => res.json(docs));
});

app.post('/api/users', auth('admin'), (req, res) => {
  const { username, password, name, rights } = req.body;
  if (!username || !password || !name) return res.json({ ok: false, error: 'Missing fields' });
  usersDB.findOne({ username }, (err, existing) => {
    if (existing) return res.json({ ok: false, error: 'Username taken' });
    const hash = bcrypt.hashSync(password, 10);
    usersDB.insert({ username, password: hash, name, rights: rights || [], createdAt: new Date() }, (err, doc) => {
      res.json({ ok: true, user: { ...doc, password: undefined } });
    });
  });
});

app.put('/api/users/:id', auth('admin'), (req, res) => {
  const { name, rights, password } = req.body;
  const update = { name, rights };
  if (password) update.password = bcrypt.hashSync(password, 10);
  usersDB.update({ _id: req.params.id }, { $set: update }, {}, () => res.json({ ok: true }));
});

app.delete('/api/users/:id', auth('admin'), (req, res) => {
  usersDB.remove({ _id: req.params.id }, {}, () => res.json({ ok: true }));
});

// ── PO ROUTES ──
app.get('/api/pos', auth('dashboard'), (req, res) => {
  posDB.find({}).sort({ createdAt: -1 }).exec((err, docs) => res.json(docs));
});

app.post('/api/pos', auth('po'), (req, res) => {
  nextCounter('po', (num) => {
    const po = { poNumber: 'PO-' + num, ...req.body, receivedQtyMT: 0, status: 'Active', createdBy: req.session.user.username, createdAt: new Date() };
    posDB.insert(po, (err, doc) => res.json({ ok: true, po: doc }));
  });
});

app.put('/api/pos/:id', auth('po'), (req, res) => {
  posDB.update({ _id: req.params.id }, { $set: req.body }, {}, () => res.json({ ok: true }));
});

// ── WEIGHBRIDGE ROUTES ──
app.get('/api/wb', auth('dashboard'), (req, res) => {
  wbDB.find({}).sort({ createdAt: -1 }).exec((err, docs) => res.json(docs));
});

app.post('/api/wb', auth('weighbridge'), (req, res) => {
  wbDB.insert({ ...req.body, labDone: false, createdBy: req.session.user.username, createdAt: new Date() }, (err, doc) => {
    res.json({ ok: true, entry: doc });
  });
});

// ── LAB / GRN ROUTES ──
app.get('/api/grns', auth('dashboard'), (req, res) => {
  grnDB.find({}).sort({ createdAt: -1 }).exec((err, docs) => res.json(docs));
});

app.post('/api/grns', auth('lab'), (req, res) => {
  nextCounter('grn', (num) => {
    const grn = { grnNumber: 'GRN-' + num, ...req.body, status: 'Pending Acceptance', createdBy: req.session.user.username, createdAt: new Date() };
    grnDB.insert(grn, (err, doc) => {
      wbDB.update({ _id: req.body.wbId }, { $set: { labDone: true } }, {});
      posDB.findOne({ poNumber: req.body.poId }, (e, po) => {
        if (po) {
          const newRecv = +((po.receivedQtyMT || 0) + req.body.receivedQ / 10).toFixed(2);
          posDB.update({ poNumber: req.body.poId }, { $set: { receivedQtyMT: newRecv } }, {});
        }
      });
      res.json({ ok: true, grn: doc });
    });
  });
});

// ── DASHBOARD ──
app.get('/api/dashboard', auth('dashboard'), (req, res) => {
  Promise.all([
    new Promise(r => posDB.find({}, (e, d) => r(d))),
    new Promise(r => wbDB.find({}, (e, d) => r(d))),
    new Promise(r => grnDB.find({}, (e, d) => r(d)))
  ]).then(([pos, wbs, grns]) => res.json({ pos, wbs, grns }));
});

// ── Serve app ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start: load DBs, seed admin, then listen ──
loadAllDBs(() => {
  seedAdmin(() => {
    app.listen(PORT, () => console.log('Biotech Fuels running on port', PORT));
  });
});
