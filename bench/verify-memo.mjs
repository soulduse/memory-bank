const REPO='/Users/jung-wankim/Project/Claude/memory-bank';
const { generateEmbedding, initEmbeddings } = await import(REPO+'/dist/embeddings.js');
import { performance } from 'perf_hooks';
await initEmbeddings();
await generateEmbedding('warmup', 'query');
let t=performance.now(); const e1=await generateEmbedding('int8 양자화 마이그레이션 어떻게 했더라', 'query'); const cold=(performance.now()-t).toFixed(1);
t=performance.now(); const e2=await generateEmbedding('int8 양자화 마이그레이션 어떻게 했더라', 'query'); const hot=(performance.now()-t).toFixed(2);
console.log(`cold: ${cold}ms, memo hit: ${hot}ms, identical: ${JSON.stringify(e1)===JSON.stringify(e2)}`);
// passage 모드는 메모 미적용 확인
t=performance.now(); await generateEmbedding('passage text', 'passage'); const p1=(performance.now()-t).toFixed(1);
t=performance.now(); await generateEmbedding('passage text', 'passage'); const p2=(performance.now()-t).toFixed(1);
console.log(`passage 1st: ${p1}ms, 2nd: ${p2}ms (메모 미적용 — 둘 다 추론)`);
