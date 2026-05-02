const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Datastore = require('nedb');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Create data dir FIRST before any DB init
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// DBs
const usersDB = new Datastore({ filename: path.join(dataDir, 'users.db'), autoload: true });
const posDB   = new Datastore({ filename: path.join(dataDir, 'pos.db'),   autoload: true });
const wbDB    = new Datastore({ filename: path.join(dataDir, 'wb.db'),     autoload: true });
const grnDB   = new Datastore({ filename: path.join(dataDir, 'grns.db'),   autoload: true });
const metaDB  = new Datastore({ filename: path.join(dataDir, 'meta.db'),   autoload: true });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'biotech-fuels-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8hr
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Seed admin on first run ──
usersDB.findOne({ username: 'admin' }, (err, doc) => {
  if (!doc) {
    bcrypt.hash('admin123', 10, (e, hash) => {
      usersDB.insert({
        username: 'admin', password: hash, name: 'Administrator',
        role: 'admin',
        rights: ['dashboard','po','weighbridge','lab','payment','admin'],
        createdAt: new Date()
      });
      console.log('Admin seeded: admin / admin123');
    });
  }
});

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

// ══════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  usersDB.findOne({ username }, (err, user) => {
    if (!user) return res.json({ ok: false, error: 'Invalid credentials' });
    bcrypt.compare(password, user.password, (e, match) => {
      if (!match) return res.json({ ok: false, error: 'Invalid credentials' });
      req.session.user = { id: user._id, username: user.username, name: user.name, role: user.role, rights: user.rights };
      res.json({ ok: true, user: req.session.user });
    });
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

// ══════════════════════════════════
// ADMIN — USERS
// ══════════════════════════════════
app.get('/api/users', auth('admin'), (req, res) => {
  usersDB.find({}, { password: 0 }, (err, docs) => res.json(docs));
});

app.post('/api/users', auth('admin'), (req, res) => {
  const { username, password, name, rights } = req.body;
  if (!username || !password || !name) return res.json({ ok: false, error: 'Missing fields' });
  usersDB.findOne({ username }, (err, existing) => {
    if (existing) return res.json({ ok: false, error: 'Username taken' });
    bcrypt.hash(password, 10, (e, hash) => {
      usersDB.insert({ username, password: hash, name, rights: rights || [], createdAt: new Date() }, (err, doc) => {
        res.json({ ok: true, user: { ...doc, password: undefined } });
      });
    });
  });
});

app.put('/api/users/:id', auth('admin'), (req, res) => {
  const { name, rights, password } = req.body;
  const update = { name, rights };
  if (password) {
    bcrypt.hash(password, 10, (e, hash) => {
      usersDB.update({ _id: req.params.id }, { $set: { ...update, password: hash } }, {}, (err) => res.json({ ok: true }));
    });
  } else {
    usersDB.update({ _id: req.params.id }, { $set: update }, {}, (err) => res.json({ ok: true }));
  }
});

app.delete('/api/users/:id', auth('admin'), (req, res) => {
  usersDB.remove({ _id: req.params.id }, {}, (err) => res.json({ ok: true }));
});

// ══════════════════════════════════
// PO ROUTES
// ══════════════════════════════════
app.get('/api/pos', auth('po'), (req, res) => {
  posDB.find({}).sort({ createdAt: -1 }).exec((err, docs) => res.json(docs));
});

app.post('/api/pos', auth('po'), (req, res) => {
  nextCounter('po', (num) => {
    const po = {
      poNumber: 'PO-' + num,
      ...req.body,
      receivedQtyMT: 0,
      status: 'Active',
      createdBy: req.session.user.username,
      createdAt: new Date()
    };
    posDB.insert(po, (err, doc) => res.json({ ok: true, po: doc }));
  });
});

app.put('/api/pos/:id', auth('po'), (req, res) => {
  posDB.update({ _id: req.params.id }, { $set: req.body }, {}, (err) => res.json({ ok: true }));
});

// ══════════════════════════════════
// WEIGHBRIDGE ROUTES
// ══════════════════════════════════
app.get('/api/wb', auth('weighbridge'), (req, res) => {
  wbDB.find({}).sort({ createdAt: -1 }).exec((err, docs) => res.json(docs));
});

app.post('/api/wb', auth('weighbridge'), (req, res) => {
  const entry = {
    ...req.body,
    labDone: false,
    createdBy: req.session.user.username,
    createdAt: new Date()
  };
  wbDB.insert(entry, (err, doc) => {
    res.json({ ok: true, entry: doc });
  });
});

// ══════════════════════════════════
// LAB / GRN ROUTES
// ══════════════════════════════════
app.get('/api/grns', auth('lab'), (req, res) => {
  grnDB.find({}).sort({ createdAt: -1 }).exec((err, docs) => res.json(docs));
});

app.post('/api/grns', auth('lab'), (req, res) => {
  nextCounter('grn', (num) => {
    const grn = {
      grnNumber: 'GRN-' + num,
      ...req.body,
      status: 'Pending Acceptance',
      createdBy: req.session.user.username,
      createdAt: new Date()
    };
    grnDB.insert(grn, (err, doc) => {
      // Mark WB entry as done
      wbDB.update({ _id: req.body.wbId }, { $set: { labDone: true } }, {});
      // Update PO received qty
      posDB.findOne({ poNumber: req.body.poId }, (e, po) => {
        if (po) {
          const newRecv = +(( po.receivedQtyMT || 0) + req.body.receivedQ / 10).toFixed(2);
          posDB.update({ poNumber: req.body.poId }, { $set: { receivedQtyMT: newRecv } }, {});
        }
      });
      res.json({ ok: true, grn: doc });
    });
  });
});

// ══════════════════════════════════
// DASHBOARD DATA
// ══════════════════════════════════
app.get('/api/dashboard', auth('dashboard'), (req, res) => {
  Promise.all([
    new Promise(r => posDB.find({}, (e, d) => r(d))),
    new Promise(r => wbDB.find({}, (e, d) => r(d))),
    new Promise(r => grnDB.find({}, (e, d) => r(d)))
  ]).then(([pos, wbs, grns]) => {
    res.json({ pos, wbs, grns });
  });
});

// ── Serve app ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('Biotech Fuels running on port', PORT));
