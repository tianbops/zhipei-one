import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname,resolve} from "node:path";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const config=readFileSync(resolve(root,"wrangler.toml"),"utf8");

test("Pages preview binds the isolated test R2 bucket",()=>{
 assert.match(config,/\[\[env\.preview\.r2_buckets\]\][\s\S]*?binding\s*=\s*"WAYBILL_FILES"[\s\S]*?bucket_name\s*=\s*"zhipei-one-files-test"/);
});

test("Pages preview binds the isolated test D1 database",()=>{
 assert.match(config,/\[\[env\.preview\.d1_databases\]\][\s\S]*?binding\s*=\s*"DB"[\s\S]*?database_name\s*=\s*"zhipei-one-test-20261108"[\s\S]*?database_id\s*=\s*"3b05311e-d97c-4f85-bc29-9374673c37ab"/);
});

test("production storage bindings remain unchanged",()=>{
 assert.match(config,/\[\[r2_buckets\]\][\s\S]*?binding\s*=\s*"WAYBILL_FILES"[\s\S]*?bucket_name\s*=\s*"zhipei-one-files"/);
 assert.match(config,/\[\[d1_databases\]\][\s\S]*?binding\s*=\s*"DB"[\s\S]*?database_name\s*=\s*"zhipei-one"[\s\S]*?database_id\s*=\s*"1f54575a-c467-4b8e-be0a-e5437ed79464"/);
});
