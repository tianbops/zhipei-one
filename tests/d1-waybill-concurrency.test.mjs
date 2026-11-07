import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {D1Backend} from "../functions/api/_db.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const processSource=readFileSync(path.join(root,"functions/api/waybills/process.js"),"utf8");
const saveScript=processSource.match(/const saveScript='([\\s\\S]*?)';/)?.[1];
assert.ok(saveScript,"the real waybill save EVAL script must exist");

class ReadBarrier {
  constructor(keys) {
    this.keys=new Set(keys);
    this.entries=new Map();
  }
  async wait(key) {
    if(!this.keys.has(key)) return;
    let entry=this.entries.get(key);
    if(!entry) {
      let release;
      const promise=new Promise(resolve=>{release=resolve;});
      entry={count:0,promise,release};
      this.entries.set(key,entry);
    }
    entry.count++;
    if(entry.count===2) entry.release();
    await entry.promise;
  }
}

class Statement {
  constructor(db,sql) { this.db=db; this.sql=sql; this.params=[]; }
  bind(...params) { this.params=params; return this; }
  async all(...params) {
    const values=params.length?params:this.params;
    const key=values[0];
    if(/^\\s*SELECT key,value,type,expires_at FROM kv WHERE key=\\?/i.test(this.sql)) {
      await this.db.barrier.wait(String(key));
    }
    return {results:this.db.raw.prepare(this.sql).all(...values)};
  }
  first(...params) {
    const values=params.length?params:this.params;
    return this.db.raw.prepare(this.sql).get(...values)??null;
  }
  run(...params) {
    const values=params.length?params:this.params;
    const result=this.db.raw.prepare(this.sql).run(...values);
    return {changes:result.changes,meta:{changes:result.changes}};
  }
}

class D1LikeAdapter {
  constructor(raw,barrier) { this.raw=raw; this.barrier=barrier; }
  prepare(sql) { return new Statement(this,sql); }
  async batch(statements) {
    this.raw.exec("BEGIN");
    try {
      const results=[];
      for(const statement of statements) {
        const prepared=this.raw.prepare(statement.sql);
        const isRead=/^\\s*(SELECT|WITH)\\b/i.test(statement.sql);
        if(isRead) results.push({results:prepared.all(...statement.params)});
        else {
          const result=prepared.run(...statement.params);
          results.push({meta:{changes:result.changes}});
        }
      }
      this.raw.exec("COMMIT");
      return results;
    } catch(error) {
      try { this.raw.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
}

test("concurrent same-signature waybill saves persist only one new record",async()=>{
  const raw=new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,type TEXT NOT NULL,expires_at INTEGER)");
  const signature="route-17|2026-11-08|渝DK7692|1.64|store-a,store-b";
  const fingerprint="route-17|2026-11-08|渝DK7692|store-a,store-b";
  const fingerprintKey="zp:waybill:fingerprint:"+fingerprint;
  const dedupeKey="zp:waybill:dedupe:"+signature;
  const indexKey="zp:route:route-17:waybills:2026-11-08";
  const barrier=new ReadBarrier([dedupeKey,fingerprintKey]);
  const backend=new D1Backend(new D1LikeAdapter(raw,barrier));
  const save=(id)=>{
    const order={id,dailyDedupeKey:signature,businessFingerprint:fingerprint};
    return backend.command([
      "EVAL",saveScript,"4",
      fingerprintKey,"zp:waybill:"+id,indexKey,dedupeKey,
      id,JSON.stringify(order),signature,fingerprint
    ]);
  };

  const results=await Promise.all([save("wb-a"),save("wb-b")]);
  const newResults=results.filter(result=>Array.isArray(result)&&result[0]==="NEW");
  const persisted=raw.prepare("SELECT COUNT(*) AS count FROM kv WHERE key LIKE 'zp:waybill:wb-%'").get().count;

  raw.close();
  assert.equal(newResults.length,1,
    "two simultaneous requests with the same daily signature must not both report NEW; results="+JSON.stringify(results));
  assert.equal(persisted,1,
    "two simultaneous requests with the same daily signature must persist exactly one waybill");
});
