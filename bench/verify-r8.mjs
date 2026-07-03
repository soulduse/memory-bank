import fs from 'fs'; import path from 'path'; import os from 'os';
const REPO='/Users/jung-wankim/Project/Claude/memory-bank';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mb-r8-'));
process.env.MEMORY_BANK_DB_PATH=path.join(tmp,'db.sqlite');
const { initDatabase, insertExchange } = await import(REPO+'/dist/db.js');
const { searchConversations } = await import(REPO+'/dist/search.js');
const db=initDatabase();
const emb=Array(384).fill(0.03);
const mk=(id,msg)=>({id,project:'t',timestamp:new Date().toISOString(),userMessage:msg,assistantMessage:'x',archivePath:'/tmp/y.jsonl',lineStart:1,lineEnd:2});
// row A: 짧은 판별 토큰(id7 cf) 포함 전토큰 매치 대상
insertExchange(db, mk('A','alpha beta gamma delta epsilon zeta id7 cf'), emb);
// row B들: 긴 boilerplate 토큰만 잔뜩 (OR 6-longest에 걸리는 후보)
for (let i=0;i<8;i++) insertExchange(db, mk('B'+i,'alphaaaaa betaaaaaa gammaaaaa deltaaaaa epsilonnn zetaaaaaa boilerplate'+i), emb);
db.close();
// 장문 쿼리(>6토큰): A의 전토큰 + 짧은 판별토큰 포함
const res = await searchConversations('alpha beta gamma delta epsilon zeta id7 cf', {limit:5, mode:'text'});
const hitA = res.some(r=>r.exchange.id==='A');
console.log((hitA?'✅':'❌'), 'R8 반례: 짧은 판별토큰 전토큰 매치(A)가 결과에 포함', '— 결과:', res.map(r=>r.exchange.id).join(','));
fs.rmSync(tmp,{recursive:true,force:true});
process.exit(hitA?0:1);
