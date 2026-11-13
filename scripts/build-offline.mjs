import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
const root=path.resolve('dist');
async function list(dir){const out=[];for(const x of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,x.name);if(x.isDirectory())out.push(...await list(p));else if(x.name!=='sw.js')out.push(p);}return out;}
const template=await fs.readFile('packaging/offline-worker.js','utf8'),files=(await list(root)).sort(),hash=crypto.createHash('sha256');for(const f of files)hash.update(await fs.readFile(f));hash.update(template);const build=hash.digest('hex').slice(0,16),urls=files.map(f=>{const name=path.relative(root,f).replaceAll('\\','/');return name==='index.html'?'./':'./'+name;});
await fs.writeFile(path.join(root,'sw.js'),template.replace('__BUILD__',JSON.stringify(build)).replace('__ASSETS__',JSON.stringify(urls)));
console.log(`Offline bundle ${build}: ${urls.length} files`);
