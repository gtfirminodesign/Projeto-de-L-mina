'use strict';
const fs=require('node:fs'),path=require('node:path');
function publication({directory=path.join(__dirname,'published'),publicUrl='http://127.0.0.1:8767/ofertas',production=false}={}){
 const file=path.join(directory,'current.html');let queue=Promise.resolve();
 return async(req,res)=>{
  const route=new URL(req.url,'http://localhost').pathname;
  if(!['/ofertas','/ofertas/','/api/publication'].includes(route))return false;
  const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
  if(route.startsWith('/ofertas')){if(!['GET','HEAD'].includes(req.method)){json(405,{error:'Método não permitido.'});return true}try{const body=await fs.promises.readFile(file);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store, max-age=0','Content-Security-Policy':"default-src 'none'; img-src data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:body)}catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('O encarte ainda não foi publicado.')}return true}
  if(req.method==='GET'){let updatedAt=null;try{updatedAt=(await fs.promises.stat(file)).mtime.toISOString()}catch{}json(200,{ready:true,publicUrl,production,updatedAt});return true}
  if(req.method!=='POST'){json(405,{error:'Método não permitido.'});return true}
  if(req.headers['x-encarte-publish']!=='1'||!String(req.headers['content-type']).startsWith('text/html')){json(400,{error:'Publicação inválida.'});return true}
  try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>40*1024*1024){json(413,{error:'O encarte ultrapassa 40 MB. Reduza as fotos.'});return true}chunks.push(chunk)}const body=Buffer.concat(chunks);const html=body.toString('utf8');if(!html.startsWith('<!DOCTYPE html>')||!html.includes('data-public-flyer="1"')||/<script\b/i.test(html))throw Error('Arquivo de encarte inválido.');const write=queue.then(async()=>{await fs.promises.mkdir(directory,{recursive:true});await fs.promises.writeFile(file+'.tmp',body);await fs.promises.rename(file+'.tmp',file)});queue=write.catch(()=>{});await write;json(200,{ok:true,publicUrl,updatedAt:new Date().toISOString()})}catch(e){json(500,{error:e.message==='Arquivo de encarte inválido.'?e.message:'Falha ao salvar publicação. A edição anterior foi mantida.'})}return true
 }
}
module.exports={publication};
