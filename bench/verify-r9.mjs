import fs from 'fs'; import path from 'path'; import os from 'os';
const REPO='/Users/jung-wankim/Project/Claude/memory-bank';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mb-r9-'));
process.env.MEMORY_BANK_DB_PATH=path.join(tmp,'db.sqlite');
const { initDatabase, insertExchange } = await import(REPO+'/dist/db.js');
const { searchConversations } = await import(REPO+'/dist/search.js');
const db=initDatabase();
const emb=Array(384).fill(0.03);
const mk=(id,msg)=>({id,project:'t',timestamp:new Date().toISOString(),userMessage:msg,assistantMessage:'x',archivePath:'/tmp/y.jsonl',lineStart:1,lineEnd:2});
const q='tokenone tokentwo tokenthree tokenfour tokenfive tokensix tokenseven';
for (let i=0;i<5;i++) insertExchange(db, mk('AND'+i, q+' filler'+i), emb);          // 전토큰 매치 5
for (let i=0;i<10;i++) insertExchange(db, mk('OR'+i, 'tokenseven only doc '+i), emb); // OR-only 10
db.close();
const res = await searchConversations(q, {limit:5, mode:'text'});
const ok = res.length <= 5;
console.log((ok?'✅':'❌'), `R9: text 모드 limit=5 계약 — 반환 ${res.length}건`);
fs.rmSync(tmp,{recursive:true,force:true});
process.exit(ok?0:1);
