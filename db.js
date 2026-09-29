'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_HOURS = {
  0: { open: 9, close: 16 }, 1: { open: 9, close: 19 }, 2: { open: 9, close: 19 }, 3: { open: 9, close: 19 },
  4: { open: 9, close: 19 }, 5: { open: 9, close: 19 }, 6: { open: 9, close: 19 },
};
const SEED_BARBERS = [
  ['b1', 'Joe', 'Owner / Lead Barber', 'en'], ['b2', 'Azim', 'Master Barber', 'en'],
  ['b3', 'Freddy', 'Master Barber', 'es'], ['b4', 'Page', 'Master Barber, Colorist & Hairstylist', 'en'],
  ['b5', 'Miguel', 'Master Barber', 'es'], ['b6', 'Dayton', 'Master Barber', 'es'],
  ['b7', 'Richard', 'Master Barber', 'es'], ['b8', 'Moses', 'Master Barber', 'es'],
];
// [id, category, name, minutes, price in dollars, note]
const SEED_SERVICES = [
  ['s1', 'Cuts', 'The Quality Cut', 30, 35, ''], ['s2', 'Cuts', 'Kids Cut', 25, 35, '12 & under'],
  ['s3', 'Cuts', 'Designs', 20, 30, 'Starting price — varies with detail'],
  ['s4', 'Shaves & Grooming', 'Hot Lather Head Shave', 30, 35, ''], ['s5', 'Shaves & Grooming', 'Traditional Shave', 30, 32, ''],
  ['s6', 'Shaves & Grooming', 'Shape Up', 15, 22, ''], ['s7', 'Shaves & Grooming', 'Beard Trim', 15, 22, ''],
  ['s8', 'Shaves & Grooming', 'Beard Enhancement', 10, 10, ''], ['s9', 'Extras', 'Shampoo', 10, 5, ''],
  ['s10', 'Extras', 'Nose & Ear Waxing', 10, 15, ''], ['s11', 'Extras', 'Face Mask', 15, 20, ''],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS owner_account (
  id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL, pass_hash TEXT NOT NULL,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS barbers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT 'en',
  email TEXT NOT NULL DEFAULT '', pin_hash TEXT, setup_token_hash TEXT, setup_expires INTEGER NOT NULL DEFAULT 0,
  days_off TEXT NOT NULL DEFAULT '[]', use_custom_hours INTEGER NOT NULL DEFAULT 0, hours TEXT,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS timeoff (
  id TEXT PRIMARY KEY, barber_id TEXT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  date TEXT NOT NULL, all_day INTEGER NOT NULL, from_t TEXT, to_t TEXT
);
CREATE INDEX IF NOT EXISTS idx_timeoff_barber ON timeoff(barber_id, date);
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL, duration INTEGER NOT NULL,
  price INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY, barber_id TEXT NOT NULL REFERENCES barbers(id), service_id TEXT NOT NULL REFERENCES services(id),
  date TEXT NOT NULL, time TEXT NOT NULL, duration INTEGER NOT NULL,
  customer_name TEXT NOT NULL, phone TEXT NOT NULL, phone_norm TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','upcoming','completed','no-show','cancelled','expired')),
  fee_cents INTEGER NOT NULL DEFAULT 0, fee_paid INTEGER NOT NULL DEFAULT 0,
  stripe_session_id TEXT, stripe_payment_intent TEXT, token_hash TEXT, hold_expires INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'online', needs_refund INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, confirmed_at INTEGER, reminded_at INTEGER, alerted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bookings_day ON bookings(date, barber_id);
CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(phone_norm);
CREATE INDEX IF NOT EXISTS idx_bookings_token ON bookings(token_hash);
CREATE TABLE IF NOT EXISTS optins (phone_norm TEXT PRIMARY KEY, opted_at TEXT NOT NULL, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocked (phone_norm TEXT PRIMARY KEY, phone TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', blocked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY, barber_id TEXT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('profile','gallery')), file TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('owner','barber','board')), subject TEXT,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, sent_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT ''
);
`;

const DEFAULT_SETTINGS = {
  name: 'Barberchops', tagline: 'Quality Cuts', address: '4163 Merrick Rd, Massapequa, NY', phone: '516.799.2887',
  bookingFee: 5, cancelWindowHours: 12, hours: DEFAULT_HOURS, ownerEmail: '', marketingPreTick: true,
  boardPinHash: null, remindersEnabled: true,
};

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
  const file = dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'barberchops.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  // first run: real barbers, services and default hours (no made-up customers)
  const count = db.prepare('SELECT COUNT(*) c FROM barbers').get().c;
  if (count === 0) {
    const now = Date.now();
    const tx = db.transaction(() => {
      SEED_BARBERS.forEach(([id, name, title, lang], i) =>
        db.prepare('INSERT INTO barbers (id,name,title,lang,sort,created_at) VALUES (?,?,?,?,?,?)').run(id, name, title, lang, i, now));
      SEED_SERVICES.forEach(([id, cat, name, dur, price, note], i) =>
        db.prepare('INSERT INTO services (id,category,name,duration,price,note,sort) VALUES (?,?,?,?,?,?,?)').run(id, cat, name, dur, price, note, i));
    });
    tx();
  }
  const has = db.prepare('SELECT 1 FROM settings WHERE key = ?');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (!has.get(k)) db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(k, JSON.stringify(v));
  }

  const api = {
    raw: db,
    getSetting(key) { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? JSON.parse(r.value) : DEFAULT_SETTINGS[key]; },
    setSetting(key, value) { db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value)); },
    settings() { const o = {}; for (const r of db.prepare('SELECT key,value FROM settings').all()) o[r.key] = JSON.parse(r.value); return o; },
    audit(actor, action, detail = '', ip = '') { db.prepare('INSERT INTO audit (ts,actor,action,detail,ip) VALUES (?,?,?,?,?)').run(Date.now(), actor, action, String(detail).slice(0, 300), String(ip).slice(0, 64)); },
    close() { db.close(); },
  };
  return api;
}

module.exports = { openDb, DEFAULT_HOURS, DEFAULT_SETTINGS };
