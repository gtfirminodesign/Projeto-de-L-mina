'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {createApp}=require('./server.cjs');
const {publication}=require('./publication.cjs');
const COOKIE='lamina_session',TTL=8*60*60;
const digest=value=>crypto.createHash('sha256').update(String(value)).digest();
const equal=(a,b)=>crypto.timingSafeEqual(digest(a),digest(b));
function createProtectedApp({username=process.env.ADMIN_USER,password=process.env.ADMIN_PASSWORD,secure=true,serverless=!!process.env.VERCEL,directory=process.env.DATA_DIR,publicUrl=process.env.PUBLIC_URL,now=Date.now}={}){
  const configured=typeof username==='string'&&username.length>0&&typeof password==='string'&&password.length>=16;
  const key=configured?digest(JSON.stringify(['lamina-session-v1',username,password])):null;
  const app=createApp({staticRoot:path.join(__dirname,'site')});
  const pub=!serverless?publication({directory,publicUrl:publicUrl?new URL('/ofertas',publicUrl).href:undefined,production:secure}):null;
  const attempts=new Map();
  const sign=payload=>crypto.createHmac('sha256',key).update(payload).digest('base64url');
  const token=()=>{const body=Buffer.from(JSON.stringify({exp:Math.floor(now()/1000)+TTL,nonce:crypto.randomBytes(16).toString('hex')})).toString('base64url');return body+'.'+sign(body)};
  function authenticated(req){
    if(!configured)return false;
    const raw=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
    if(raw.length>1024)return false;
    const parts=raw.split('.');if(parts.length!==2||!equal(parts[1],sign(parts[0])))return false;
    try{const data=JSON.parse(Buffer.from(parts[0],'base64url').toString());return Number.isInteger(data.exp)&&data.exp>now()/1000&&data.exp<=now()/1000+TTL}catch{return false}
  }
  const cookie=(value,maxAge)=>`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;
  return async(req,res)=>{
    const send=(status,body,type='text/html; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type});res.end(req.method==='HEAD'?undefined:body)};
    const redirect=location=>{res.writeHead(303,{Location:location});res.end()};
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
    try{
      const url=new URL(req.url,'http://localhost'),route=url.pathname;
      const read=async file=>fs.promises.readFile(path.join(__dirname,'public',file),'utf8');
      if(['GET','HEAD'].includes(req.method)&&['/','/index.html','/presentation.css'].includes(route))return send(200,await read(route==='/presentation.css'?'presentation.css':'index.html'),route==='/presentation.css'?'text/css; charset=utf-8':undefined);
      const expectedOrigin=publicUrl?new URL(publicUrl).origin:`${secure?'https':'http'}://${req.headers.host}`;
      if(!['GET','HEAD'].includes(req.method)&&(req.headers.origin!==expectedOrigin||req.headers['sec-fetch-site']==='cross-site'))return send(403,'Origem não permitida.','text/plain; charset=utf-8');
      if(route==='/logout'){
        if(req.method!=='POST')return send(405,'Use o botão Sair do editor.');
        res.setHeader('Set-Cookie',cookie('',0));return redirect('/');
      }
      if(route==='/login'){
        if(!configured)return send(503,await read('login.html').then(s=>s.replace('<!--MESSAGE-->','<p class="error" role="alert">O acesso ainda não foi configurado. Defina ADMIN_USER e ADMIN_PASSWORD na hospedagem.</p>')));
        if(['GET','HEAD'].includes(req.method)){if(authenticated(req))return redirect('/editor');return send(200,await read('login.html'))}
        if(req.method!=='POST')return send(405,'Método não permitido.');
        if(!String(req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'))return send(415,'Formato inválido.');
        const ip=req.socket?.remoteAddress||'unknown';
        // Best-effort throttling per running instance; never trust forwarded client IPs.
        for(const [k,v] of attempts)if(v.until<=now())attempts.delete(k);
        const entry=attempts.get(ip)||{count:0,until:now()+15*60*1000};
        if(entry.count>=10){res.setHeader('Retry-After',String(Math.ceil((entry.until-now())/1000)));return send(429,await read('login.html').then(s=>s.replace('<!--MESSAGE-->','<p class="error" role="alert">Muitas tentativas. Aguarde 15 minutos para tentar novamente.</p>')))}
        let form;
        if(req.body!==undefined){
          const body=req.body;
          if(Buffer.byteLength(typeof body==='string'?body:JSON.stringify(body))>8192)return send(413,'Formulário muito grande.');
          if(body&&typeof body==='object'&&!Buffer.isBuffer(body)){
            if(typeof body.username!=='string'||typeof body.password!=='string')return send(400,'Formulário inválido.');
            form=new URLSearchParams({username:body.username,password:body.password});
          }else form=new URLSearchParams(String(body));
        }else{
          let bytes=0;const chunks=[];
          for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)return send(413,'Formulário muito grande.');chunks.push(chunk)}
          form=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        }
        const userOK=equal(form.get('username')||'',username),passwordOK=equal(form.get('password')||'',password);
        if(!(userOK&&passwordOK)){
          entry.count++;if(attempts.size>=1000&&!attempts.has(ip))attempts.delete(attempts.keys().next().value);attempts.set(ip,entry);
          return send(401,await read('login.html').then(s=>s.replace('<!--MESSAGE-->','<p class="error" role="alert">Usuário ou senha incorretos. Tente novamente.</p>')));
        }
        attempts.delete(ip);res.setHeader('Set-Cookie',cookie(token(),TTL));return redirect('/editor');
      }
      if(['/ofertas','/ofertas/'].includes(route)){
        if(pub)return await pub(req,res);
        return send(503,'<h1>Encarte ainda indisponível</h1><p>A publicação de ofertas precisa de armazenamento persistente nesta hospedagem.</p><a href="/">Voltar à apresentação</a>');
      }
      if(!configured)return send(503,'Configure ADMIN_USER e ADMIN_PASSWORD na hospedagem.','text/plain; charset=utf-8');
      if(!authenticated(req)){
        if(route.startsWith('/api/'))return send(401,JSON.stringify({error:'Entre com usuário e senha para continuar.'}),'application/json; charset=utf-8');
        return redirect('/login');
      }
      if(route==='/api/publication'){
        if(pub)return await pub(req,res);
        return send(503,JSON.stringify({error:'Publicação com QR Code requer armazenamento persistente. A edição e exportação estão disponíveis.'}),'application/json; charset=utf-8');
      }
      if(['/editor','/editor/','/editor/index.html'].includes(route)){
        if(!['GET','HEAD'].includes(req.method))return send(405,'Método não permitido.');
        const html=(await fs.promises.readFile(path.join(__dirname,'site','index.html'),'utf8')).replace('<head>','<head><base href="/editor/">');
        return send(200,html.replace('<body>','<body><div class="session-bar"><a href="/">← Apresentação</a><form method="post" action="/logout"><button type="submit">Sair do editor</button></form></div><style>.session-bar{position:fixed;bottom:12px;right:16px;z-index:1000;display:flex;align-items:center;gap:14px;padding:8px 12px;border:1px solid #ccd8cf;border-radius:10px;background:#fff;box-shadow:0 4px 18px #0002;font:13px system-ui}.session-bar a{color:#174c37}.session-bar form{margin:0}.session-bar button{cursor:pointer;border:0;border-radius:6px;background:#173f30;color:#fff;padding:8px 10px}@media print{.session-bar{display:none}}</style><script>addEventListener("pageshow",function(e){if(e.persisted)location.reload()});</script>'));
      }
      if(route.startsWith('/editor/')){
        const relative=route.slice('/editor'.length);
        let decoded;try{decoded=decodeURIComponent(relative)}catch{return send(400,'Endereço inválido.')}
        if(decoded.startsWith('/api/')||decoded.startsWith('/ofertas'))return send(404,'Não encontrado.');
        req.url=relative+url.search;
      }else if(!['/api/health','/api/product-search','/api/product-image'].includes(route))return send(404,'Não encontrado.');
      req.headers.host='127.0.0.1:8767';delete req.headers.origin;
      const originalWriteHead=res.writeHead;
      res.writeHead=function(status,headers){return originalWriteHead.call(this,status,{...headers,'Cache-Control':'private, no-store'})};
      return await app(req,res);
    }catch{if(!res.headersSent)send(500,'Não foi possível concluir a operação. Tente novamente.','text/plain; charset=utf-8');else res.destroy()}
  };
}
module.exports={createProtectedApp};
