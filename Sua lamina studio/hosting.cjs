/* Public deployment entry point. Configure PUBLIC_URL, ADMIN_PASSWORD, DATA_DIR. */
'use strict';
const http=require('node:http'),crypto=require('node:crypto');
const {createApp}=require('./server.cjs'),{publication}=require('./publication.cjs');
const origin=new URL(process.env.PUBLIC_URL||'http://localhost');
if(origin.protocol!=='https:'||!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<16||!process.env.DATA_DIR)throw Error('Configure PUBLIC_URL (HTTPS), ADMIN_PASSWORD (16+ caracteres) e DATA_DIR persistente.');
const pub=publication({directory:process.env.DATA_DIR,publicUrl:origin.origin+'/ofertas',production:true}),app=createApp();
http.createServer(async(req,res)=>{
 const pathname=new URL(req.url,origin.origin).pathname;
 if(['/ofertas','/ofertas/'].includes(pathname)){await pub(req,res);return}
 const auth='Basic '+Buffer.from('admin:'+process.env.ADMIN_PASSWORD).toString('base64'),provided=String(req.headers.authorization||'');
 if(provided.length!==auth.length||!crypto.timingSafeEqual(Buffer.from(auth),Buffer.from(provided))){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Sua Lamina studio", charset="UTF-8"'});res.end('Acesso do administrador.');return}
 if(req.headers.origin&&req.headers.origin!==origin.origin){res.writeHead(403);res.end('Origem inválida.');return}
 if(pathname==='/api/publication'){await pub(req,res);return}
 req.headers.host='127.0.0.1:8767';delete req.headers.origin;await app(req,res);
}).listen(Number(process.env.PORT)||3000,'0.0.0.0');
