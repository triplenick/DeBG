const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../dist');
const server = http.createServer(async (req, res) => {
  try {
    const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid path');
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const win = new BrowserWindow({ show: false, width: 380, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, webSecurity: false } });
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}`);
    const report = await win.webContents.executeJavaScript(`(async () => {
      const wait = async fn => { for(let i=0;i<200;i++) { if(fn()) return; await new Promise(r=>setTimeout(r,50)); } throw new Error('UI timeout'); };
      await wait(()=>document.querySelector('.dropzone'));
      localStorage.removeItem('debg.autoProcess');
      const canvas = new OffscreenCanvas(100,80), ctx=canvas.getContext('2d');
      ctx.fillStyle='black';ctx.fillRect(0,0,100,80);ctx.fillStyle='white';ctx.fillRect(30,20,20,30);
      const blob=await canvas.convertToBlob();
      let calls=0, active=0, maxActive=0;
      window.fetch=async url => {
        if(String(url).endsWith('/openapi.json')) return new Response(JSON.stringify({info:{title:'Rembg'},paths:{'/api/remove':{post:{}}}}));
        calls++;active++;maxActive=Math.max(maxActive,active);
        await new Promise(r=>setTimeout(r,300));active--;return new Response(blob);
      };
      const add=name=>{const dt=new DataTransfer();dt.items.add(new File([blob],name,{type:'image/png'}));const input=document.querySelector('#file-input');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));};
      add('first.png');
      await new Promise(r=>setTimeout(r,100));
      if(calls) throw new Error('Manual mode started automatically');
      document.querySelector('.auto-process input').click();
      await wait(()=>calls===1);add('second.png');
      await wait(()=>document.querySelectorAll('.card-done').length===2);
      const names=[...document.querySelectorAll('.card-meta .name')].map(x=>x.textContent);
      const dock=document.querySelector('.process-dock').getBoundingClientRect();
      return {calls,maxActive,names,overflow:document.documentElement.scrollWidth>innerWidth,closed:[...document.querySelectorAll('details')].every(x=>!x.open),dockBottom:dock.bottom,height:innerHeight};
    })()`);
    assert.equal(report.calls,2);assert.equal(report.maxActive,1);
    assert.deepEqual(report.names,['second.png','first.png']);assert.equal(report.closed,true);
    assert.equal(report.overflow,false);assert.equal(report.dockBottom,report.height);
    await new Promise(r => setTimeout(r, 200));
    await fs.writeFile(path.join(app.getPath('temp'),'debg-narrow.png'),(await win.webContents.capturePage()).toPNG());
    console.log('PASS: manual/auto processing, arrivals during processing, newest-first, collapsed panels, narrow overflow and fixed dock',report);
    app.exit(0);
  } catch(e) {console.error(e);app.exit(1);} finally {server.close();}
});
