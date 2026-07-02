process.env.MEMORY_BANK_DB_PATH='/Users/jung-wankim/Project/Claude/memory-bank/.autoresearch/bench-db.sqlite';
import fs from 'fs';
const REPO='/Users/jung-wankim/Project/Claude/memory-bank';
const { searchConversations } = await import(REPO+'/dist/search.js');
const qs = JSON.parse(fs.readFileSync(REPO+'/.autoresearch/queries.json','utf8')).slice(0,100);
const missTop=[], hitTop=[];
for (const {id,pfx,query} of qs) {
  const res = await searchConversations(query, { limit: 10, mode: 'vector' });
  const hit = res.some(r => r.exchange.id===id || (pfx && r.exchange.userMessage.startsWith(pfx)));
  const top = res[0]?.similarity ?? 0;
  (hit?hitTop:missTop).push(+top.toFixed(3));
}
hitTop.sort((a,b)=>a-b); missTop.sort((a,b)=>a-b);
console.log('vector-only misses:', missTop.length);
console.log('miss top-1 sims:', missTop.join(','));
console.log('hit  top-1 sims: min',hitTop[0],'p10',hitTop[Math.floor(hitTop.length*0.1)],'p25',hitTop[Math.floor(hitTop.length*0.25)],'median',hitTop[Math.floor(hitTop.length*0.5)]);
