import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, chmodSync, lstatSync } from 'node:fs';
// Cross-process INSERT OR IGNORE owns a dispatch before any async preflight.
// SQLite durability replaces an append-log cache that could admit duplicate writers.
export class FileJournal {
 constructor(path) {
  try {closeSync(openSync(path,'wx',0o600));} catch(error) {if(error.code!=='EEXIST')throw error;}
  if(!lstatSync(path).isFile())throw new Error('journal_not_regular');
  chmodSync(path,0o600);
  this.db=new DatabaseSync(path);
  this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY, record TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY, event TEXT NOT NULL);`);
 }
 get(key) {const row=this.db.prepare('SELECT record FROM operations WHERE key=?').get(key);return row?JSON.parse(row.record):undefined;}
 reserve(key,record) {return this.db.prepare('INSERT OR IGNORE INTO operations(key,record) VALUES (?,?)').run(key,JSON.stringify(record)).changes===1;}
 put(key,record) {
  if(this.db.prepare('UPDATE operations SET record=? WHERE key=?').run(JSON.stringify(record),key).changes!==1)throw new Error('operation_not_reserved');
 }
 audit(event) {this.db.prepare('INSERT INTO audit(event) VALUES (?)').run(JSON.stringify({at:new Date().toISOString(),...event}));}
 close() {this.db.close();}
}
