'use strict';
const {createProtectedApp}=require('../access.cjs');
let app;
module.exports=async(req,res)=>{
  const url=new URL(req.url,'https://localhost');
  const route=url.searchParams.get('route');
  if(route){
    if(!route.startsWith('/')||route.startsWith('//')||route.includes('?')||route.includes('#')){res.statusCode=400;return res.end('Endereço inválido.');}
    url.searchParams.delete('route');
    req.url=route+(url.searchParams.size?'?'+url.searchParams.toString():'');
  }
  app ||= createProtectedApp({secure:true,serverless:true});
  return app(req,res);
};
