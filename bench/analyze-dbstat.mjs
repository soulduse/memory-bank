import fs from 'fs'; import path from 'path'; import os from 'os';
const REPO='/Users/jung-wankim/Project/Claude/memory-bank';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mb-stat-'));
process.env.MEMORY_BANK_DB_PATH=path.join(tmp,'db.sqlite');
const { initDatabase, insertExchange } = await import(REPO+'/dist/db.js');
const { parseConversationFile } = await import(REPO+'/dist/parser.js');
function fake(seed){let a=seed>>>0;const v=new Array(384);for(let i=0;i<384;i++){a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;v[i]=(((t^(t>>>14))>>>0)/4294967296)-0.5;}return v;}
const db=initDatabase();
let seed=42, n=0;
for(const f of fs.readdirSync(REPO+'/test/fixtures').filter(x=>x.endsWith('.jsonl'))){
  const {exchanges}=await parseConversationFile(REPO+'/test/fixtures/'+f);
  for(const ex of exchanges){ insertExchange(db,ex,fake(seed++)); n++; }
}
db.pragma('wal_checkpoint(TRUNCATE)');
console.log('exchanges inserted:',n);
for(const r of db.prepare("SELECT name,SUM(pgsize) sz FROM dbstat GROUP BY name ORDER BY sz DESC LIMIT 12").all())
  console.log(String((r.sz/1024).toFixed(0)).padStart(7),'KB ',r.name);
db.close();
fs.rmSync(tmp,{recursive:true,force:true});
