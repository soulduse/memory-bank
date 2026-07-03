import fs from 'fs'; import path from 'path'; import os from 'os';
const REPO='/Users/jung-wankim/Project/Claude/memory-bank';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mb-r10-'));
process.env.MEMORY_BANK_DB_PATH=path.join(tmp,'db.sqlite');
const { initDatabase, insertExchange } = await import(REPO+'/dist/db.js');
const { searchConversations } = await import(REPO+'/dist/search.js');
const db=initDatabase();
const emb=Array(384).fill(0.03);
const mk=(id,msg)=>({id,project:'t',timestamp:new Date().toISOString(),userMessage:msg,assistantMessage:'x',archivePath:'/tmp/y.jsonl',lineStart:1,lineEnd:2});
const q='tokenone tokentwo tokenthree tokenfour tokenfive tokensix tokenseven';
insertExchange(db, mk('AND0', q+' 정확매치'), emb);                                   // AND 1개
for (let i=0;i<5;i++) insertExchange(db, mk('OR'+i, 'tokenseven only doc '+i), emb);  // OR-only 5
for (let i=1;i<10;i++) insertExchange(db, mk('AND'+i, q+' 추가정확 '+i), emb);        // AND 총 10개
db.close();
let pass=0, fail=0;
const check=(n,ok)=>{console.log((ok?'✅':'❌'),n); ok?pass++:fail++;};
// (1) 리뷰어 시나리오: limit=5 text 모드 → ≤5
const r1 = await searchConversations(q, {limit:5, mode:'text'});
check(`R10-1: text limit=5 계약 (반환 ${r1.length})`, r1.length <= 5);
// (2) both 모드에서 정확(AND) 매치가 limit까지 전부 fetch — 10개 정확매치, limit=10
const r2 = await searchConversations(q, {limit:10, mode:'text'});
const andCount = r2.filter(r=>r.exchange.id.startsWith('AND')).length;
check(`R10-2: 정확매치 10개 모두 우선 반환 (AND ${andCount}/10, OR-only ${r2.length-andCount})`, andCount === 10);
fs.rmSync(tmp,{recursive:true,force:true});
console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
