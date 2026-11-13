import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(fileURLToPath(new URL('./dist/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.hea':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/__health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({app:'ecg-vector-learning',version:'1.0.0'}));}
  let name=path.resolve(root,'.'+decodeURIComponent(url.pathname));
  if(name!==root&&!name.startsWith(root+path.sep)){res.writeHead(403);return res.end('Forbidden');}
  if(url.pathname==='/')name=path.join(root,'index.html');
  const s=await stat(name);if(!s.isFile())throw Error('Not found');
  res.writeHead(200,{'Content-Type':mime[path.extname(name)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(await readFile(name));
 }catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found');}
});
server.listen(5186,'127.0.0.1',()=>console.log('心向 · http://127.0.0.1:5186'));
server.on('error',e=>{console.error(e.message);process.exitCode=1;});

