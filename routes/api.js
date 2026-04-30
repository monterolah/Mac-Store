'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const PDFDocument = require('pdfkit');

const { uploadToStorage }    = require('../utils/storageUpload');
const { requireAdminAPI }    = require('../middleware/auth');
const { clearCache }         = require('../utils/cache');
const { importCatalogFromWorkbook, importInventoryWorkbook } = require('../utils/catalogImport');
const { exportSite, createZip } = require('../utils/staticExport');
const { deployToGodaddy }       = require('../utils/ftpDeploy');
const { patchSavedHtml, extractLogoStyle } = require('../utils/htmlPatch');

const {
  getSettings, setSettings,
  getAllProducts, getProductById, getProductBySlug, insertProduct, updateProduct, deleteProduct,
  getAllCategories, insertCategory, updateCategory, deleteCategory,
  getAllBanners, insertBanner, updateBanner, deleteBanner,
  getAllAnnouncements, insertAnnouncement, updateAnnouncement, deleteAnnouncement,
  getAllPaymentMethods, insertPaymentMethod, updatePaymentMethod, deletePaymentMethod,
  getAllQuotations, getQuotationById, insertQuotation, deleteQuotation,
  getAllInventoryEntries, getInventoryEntryById, updateInventoryEntry,
  getAdminByEmail, getPageDesign, savePageDesign, getAllPageDesigns,
  dbGet,
} = require('../db/sqlite');

const ejs  = require('ejs');
const ppath = require('path');

const router = express.Router();

// Aplica patchSavedHtml a todas las páginas guardadas y actualiza el DB
function persistPatches() {
  try {
    const designs = getAllPageDesigns();
    const allActive = getAllProducts({ active: true });
    const allActiveSlugs = allActive.map(p => p.slug).filter(Boolean);

    for (const d of designs) {
      if (!d.html || !d.html.trim()) continue;
      try {
        // Para páginas de listado (no producto individual): si falta algún producto
        // activo (su tarjeta fue eliminada por código anterior), limpiar el HTML
        // guardado para que la próxima visita regenere desde EJS con todos los productos.
        if (!d.page_name.startsWith('product-')) {
          let expected;
          if (d.page_name === 'catalog' || d.page_name === 'home') {
            expected = allActiveSlugs;
          } else if (d.page_name.startsWith('category-')) {
            const catSlug = d.page_name.slice(9);
            expected = allActive
              .filter(p => p.category === catSlug || p.cat_slug === catSlug)
              .map(p => p.slug).filter(Boolean);
          } else {
            expected = [];
          }
          const missing = expected.filter(slug => !d.html.includes('/producto/' + slug + '"'));
          if (missing.length > 0) {
            savePageDesign(d.page_name, '', d.css || '', d.gjs_data || '{}');
            continue;
          }
        }
        const patched = patchSavedHtml(d.page_name, d.html);
        savePageDesign(d.page_name, patched, d.css || '', d.gjs_data || '{}');
      } catch(e) {
        console.warn('[persistPatches] skip', d.page_name, e.message);
      }
    }
  } catch(e) {
    console.error('[persistPatches] ERROR', e.message);
  }
}

// ── Invalidar caché y re-parchear tras cambios de administrador ───────────
router.use((req, res, next) => {
  if (['POST','PUT','DELETE','PATCH'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400 &&
          !req.originalUrl.includes('/auth/login') &&
          !req.originalUrl.includes('/upload') &&
          !req.originalUrl.includes('/editor/')) {
        clearCache();
        setImmediate(persistPatches);
      }
    });
  }
  next();
});

// ── MULTER ────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file || !file.originalname) return cb(new Error('Archivo inválido'));
    const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    ok ? cb(null, true) : cb(new Error('Solo imágenes y videos'));
  }
});

const excelUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => { const d = path.join(__dirname,'../temp_uploads'); fs.mkdirSync(d,{recursive:true}); cb(null,d); },
    filename: (_req, file, cb) => { cb(null, `catalog-${Date.now()}${path.extname(file.originalname)||'.xlsx'}`); }
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /sheet|excel|spreadsheetml|csv/i.test(file.mimetype) || /\.(xlsx|xls|csv)$/i.test(file.originalname||'');
    ok ? cb(null,true) : cb(new Error('Solo Excel o CSV'));
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────
function slugify(str) {
  return String(str).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}
function badRequest(res, msg)  { return res.status(400).json({ error: msg }); }
function parseJsonField(v, fb) { if (v===undefined||v===null||v==='') return fb; if (typeof v==='object') return v; try { return JSON.parse(v); } catch { throw new Error('JSON inválido'); } }
function toBool(v, fb=false)   { if (v===undefined||v===null||v==='') return fb; if (typeof v==='boolean') return v; return v==='1'||v==='true'||v==='on'; }
function toNumber(v, fb=0)     { const n=Number(v); return Number.isFinite(n)?n:fb; }
function cleanText(v, max=5000){ return String(v||'').trim().slice(0,max); }

// ══════════════════════════════════════════════════════════════════════════
// PDF NATIVO CON PDFKIT
// ══════════════════════════════════════════════════════════════════════════
const C = { black:'#1d1d1f',white:'#ffffff',grey:'#515154',lightG:'#86868b',bg:'#f5f5f7',border:'#e8e8ed',blue:'#0071e3',blueBg:'#f5f5f7',green:'#1a7f37',greenBg:'#f0f0f0',accent:'#1d1d1f',rowAlt:'#fafafa' };

function parseBase64Image(b64) {
  if (!b64) return null;
  try { const m=b64.match(/^data:(image\/\w+);base64,(.+)$/); return m ? Buffer.from(m[2],'base64') : null; } catch { return null; }
}

function buildPdfBuffer(q) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size:'A4', margins:{top:40,bottom:40,left:44,right:44} });
      const chunks = []; doc.on('data',c=>chunks.push(c)); doc.on('end',()=>resolve(Buffer.concat(chunks))); doc.on('error',reject);
      const W=doc.page.width-88, LM=44; let y=40;
      const drawLine=(x1,yL,x2,color,width)=>doc.strokeColor(color||C.black).lineWidth(width||1).moveTo(x1,yL).lineTo(x2,yL).stroke();
      const drawRect=(x,yR,w,h,fill)=>doc.rect(x,yR,w,h).fill(fill);
      const checkPage=(needed)=>{ if(y+needed>doc.page.height-50){doc.addPage();y=40;} };
      const items=Array.isArray(q.items)?q.items:[], ivaMode=q.ivaMode||'con', options=q.options||{}, settings=q.settings||{}, payMethods=Array.isArray(q.paymentMethods)?q.paymentMethods:[];
      const storeName=settings.store_name||'MacStore', storeTagline=settings.store_tagline||'Distribuidor Autorizado Apple';
      const dateStr=new Date().toLocaleDateString('es-SV',{year:'numeric',month:'long',day:'numeric'});
      const validText=q.validity==='0'?'Sin vencimiento':`Válida por ${q.validity||7} días`;
      doc.font('Helvetica-Bold').fontSize(26).fillColor(C.black).text(storeName,LM,y); y+=30;
      doc.font('Helvetica').fontSize(10).fillColor(C.lightG).text(storeTagline,LM,y); y+=18;
      drawLine(LM,y,LM+W,C.black,2); y+=16;
      const metaW=(W-14)/2, infoX=LM+metaW+14, metaH=68;
      doc.save(); doc.roundedRect(LM,y,metaW,metaH,6).fill(C.bg); doc.restore();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.lightG).text('COTIZACIÓN PARA',LM+14,y+12);
      doc.font('Helvetica-Bold').fontSize(15).fillColor(C.black).text(q.client||'—',LM+14,y+26,{width:metaW-28});
      if(q.company) doc.font('Helvetica').fontSize(10).fillColor(C.grey).text(q.company,LM+14,y+44,{width:metaW-28});
      doc.save(); doc.roundedRect(infoX,y,metaW,metaH,6).fill(C.bg); doc.restore();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.lightG).text('INFORMACIÓN',infoX+14,y+12);
      doc.font('Helvetica-Bold').fontSize(15).fillColor(C.black).text(q.qNum||'',infoX+14,y+26,{width:metaW-28});
      doc.font('Helvetica').fontSize(9).fillColor(C.grey).text(`Emitida: ${dateStr}`,infoX+14,y+44);
      doc.font('Helvetica').fontSize(9).fillColor(C.grey).text(validText,infoX+14,y+56);
      y+=metaH+12;
      if(q.seller){ checkPage(24); const bl=`Vendedor: ${q.seller}`; doc.font('Helvetica-Bold').fontSize(9); const bw=doc.widthOfString(bl)+20; doc.save(); doc.roundedRect(infoX+14,y,bw,18,9).fill(C.bg); doc.restore(); doc.font('Helvetica-Bold').fontSize(9).fillColor(C.grey).text(bl,infoX+24,y+4); y+=26; }
      y+=8; checkPage(40);
      const colX=[LM,LM+W*0.55,LM+W*0.7,LM+W*0.85], colW=[W*0.55,W*0.15,W*0.15,W*0.15];
      const ivaHeader=ivaMode==='con'?'Precio c/IVA':'Precio s/IVA';
      doc.save(); doc.roundedRect(LM,y,W,28,6).fill(C.black); doc.restore();
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.white);
      doc.text('PRODUCTO',colX[0]+12,y+9); doc.text('CANT.',colX[1],y+9,{width:colW[1],align:'center'}); doc.text(ivaHeader.toUpperCase(),colX[2],y+9,{width:colW[2],align:'right'}); doc.text('TOTAL',colX[3],y+9,{width:colW[3],align:'right'}); y+=28;
      items.forEach((item,idx)=>{
        const price=parseFloat(item.price)||0, qty=parseInt(item.qty)||1, disc=parseFloat(item.discount)||0;
        const gross=price*qty, discAmt=gross*(disc/100), net=gross-discAmt;
        let unitShow,lineTotal;
        if(ivaMode==='exento'||ivaMode==='desglosado'){unitShow=price/1.13;lineTotal=net/1.13;}else{unitShow=price;lineTotal=net;}
        const hasSpecs=options.showSpecs&&item.specs&&typeof item.specs==='object'&&Object.keys(item.specs).length>0;
        const hasFicha=options.showFichaGlobal&&item.ficha&&typeof item.ficha==='object'&&Object.keys(item.ficha).length>0;
        const specEntries=hasSpecs?Object.entries(item.specs).filter(([,v])=>v!=null&&String(v).trim()!==''):[];
        const fichaEntries=hasFicha?Object.entries(item.ficha).filter(([,v])=>v!=null&&String(v).trim()!==''):[];
        const colors=Array.isArray(item.selectedColors)?item.selectedColors.filter(Boolean):[];
        let rowH=28; if(specEntries.length)rowH+=specEntries.length*14+8; if(fichaEntries.length)rowH+=fichaEntries.length*22+14; if(disc>0)rowH+=14; if(colors.length)rowH+=16; rowH=Math.max(rowH,50);
        const imgBuf=parseBase64Image(item.image_base64); if(imgBuf)rowH=Math.max(rowH,70);
        checkPage(rowH+4);
        if(idx%2===0){doc.save();doc.rect(LM,y,W,rowH).fill(C.rowAlt);doc.restore();}
        if(idx>0)drawLine(LM,y,LM+W,C.border,0.4);
        y+=6; const rowStartY=y; let contentX=colX[0]+12;
        if(imgBuf){try{doc.image(imgBuf,contentX,y,{width:50,height:50,fit:[50,50]});}catch(e){}contentX+=60;}
        const nameText=item.variant?`${item.name||''} — ${item.variant}`:(item.name||'');
        doc.font('Helvetica-Bold').fontSize(11).fillColor(C.black);
        const nameW=colW[0]-(contentX-colX[0])-8; doc.text(nameText,contentX,y,{width:nameW}); y+=doc.heightOfString(nameText,{width:nameW})+4;
        if(colors.length){doc.font('Helvetica').fontSize(8).fillColor(C.grey).text(`Colores: ${colors.join(', ')}`,contentX,y,{width:nameW});y+=12;}
        if(specEntries.length){const specW=nameW;specEntries.forEach(([k,v],si)=>{if(si%2===0)drawRect(contentX,y-1,specW,13,'#f9f9f9');doc.font('Helvetica-Bold').fontSize(8).fillColor(C.grey).text(k,contentX+4,y+1,{width:specW*0.38});doc.font('Helvetica').fontSize(8).fillColor(C.black).text(String(v),contentX+specW*0.4,y+1,{width:specW*0.58});y+=14;});y+=4;}
        if(fichaEntries.length){const fichaW=nameW;doc.font('Helvetica-Bold').fontSize(7).fillColor(C.lightG).text('FICHA TÉCNICA',contentX,y);y+=10;fichaEntries.forEach(([k,v],fi)=>{const valStr=String(v),valH=doc.font('Helvetica').fontSize(8).heightOfString(valStr,{width:fichaW*0.57}),rH=Math.max(valH,10)+8;if(fi%2===0)drawRect(contentX,y-2,fichaW,rH+2,'#f9f9f9');doc.font('Helvetica-Bold').fontSize(8).fillColor(C.grey).text(String(k),contentX+4,y+3,{width:fichaW*0.37});doc.font('Helvetica').fontSize(8).fillColor(C.black).text(valStr,contentX+fichaW*0.4,y+3,{width:fichaW*0.57});y+=rH+2;});y+=6;}
        if(disc>0){doc.font('Helvetica').fontSize(8).fillColor(C.green).text(`Descuento ${disc}% aplicado (−$${discAmt.toFixed(2)})`,contentX,y);y+=14;}
        const numY=rowStartY+Math.max((y-rowStartY)/2-6,4);
        doc.font('Helvetica').fontSize(11).fillColor(C.black).text(String(qty),colX[1],numY,{width:colW[1],align:'center'}).text(`$${unitShow.toFixed(2)}`,colX[2],numY,{width:colW[2],align:'right'});
        doc.font('Helvetica-Bold').fontSize(11).fillColor(C.black).text(`$${lineTotal.toFixed(2)}`,colX[3],numY,{width:colW[3],align:'right'});
        if(imgBuf)y=Math.max(y,rowStartY+54); y+=6;
      });
      y+=8; checkPage(80);
      let sub=0,iva=0;
      items.forEach(item=>{ const price=parseFloat(item.price)||0,qty=parseInt(item.qty)||1,disc=parseFloat(item.discount)||0,gross=price*qty,discAmt=gross*(disc/100),net=gross-discAmt; if(ivaMode==='exento'){sub+=net/1.13;}else if(ivaMode==='desglosado'){const s=net/1.13;sub+=s;iva+=net-s;}else{sub+=net;} });
      const total=sub+iva, totX=LM+W-220, totW=220;
      if(ivaMode!=='con'){doc.font('Helvetica').fontSize(11).fillColor(C.grey).text('Subtotal sin IVA',totX,y,{width:totW*0.55}).text(`$${sub.toFixed(2)}`,totX+totW*0.55,y,{width:totW*0.45,align:'right'});y+=18;}
      if(ivaMode==='desglosado'){doc.font('Helvetica').fontSize(11).fillColor(C.grey).text('IVA (13%)',totX,y,{width:totW*0.55}).text(`$${iva.toFixed(2)}`,totX+totW*0.55,y,{width:totW*0.45,align:'right'});y+=18;}
      if(ivaMode==='exento'){doc.font('Helvetica').fontSize(11).fillColor(C.grey).text('IVA',totX,y,{width:totW*0.4});const exText='EXENTO';doc.font('Helvetica-Bold').fontSize(8);const exW=doc.widthOfString(exText)+14;doc.save();doc.roundedRect(totX+totW-exW,y-2,exW,16,5).fill(C.greenBg);doc.restore();doc.font('Helvetica-Bold').fontSize(8).fillColor(C.green).text(exText,totX+totW-exW+7,y+1);y+=18;}
      drawLine(totX,y,totX+totW,C.black,1.5); y+=8;
      doc.font('Helvetica-Bold').fontSize(18).fillColor(C.black).text('Total',totX,y,{width:totW*0.45}).text(`$${total.toFixed(2)}`,totX+totW*0.45,y,{width:totW*0.55,align:'right'}); y+=28;
      if(options.showCuotasPDF){
        checkPage(80); const div1=parseInt(q.div1)||6,div2=parseInt(q.div2)||10,lbl1=q.lbl1||'6 cuotas sin intereses',lbl2=q.lbl2||'10 cuotas sin intereses';
        doc.font('Helvetica-Bold').fontSize(8).fillColor(C.lightG).text('OPCIONES DE FINANCIAMIENTO',LM,y); y+=14;
        const cuotaW=(W-16)/2,cuotaH=64;
        doc.save();doc.roundedRect(LM,y,cuotaW,cuotaH,8).lineWidth(1).strokeColor(C.border).stroke();doc.restore();
        doc.font('Helvetica').fontSize(9).fillColor(C.lightG).text(lbl1,LM,y+10,{width:cuotaW,align:'center',lineBreak:false});
        doc.font('Helvetica-Bold').fontSize(20).fillColor(C.black).text(`$${(total/div1).toFixed(2)}`,LM,y+24,{width:cuotaW,align:'center',lineBreak:false});
        doc.font('Helvetica').fontSize(8).fillColor(C.lightG).text('por mes',LM,y+46,{width:cuotaW,align:'center',lineBreak:false});
        const c2x=LM+cuotaW+14;
        doc.save();doc.roundedRect(c2x,y,cuotaW,cuotaH,8).lineWidth(1).strokeColor(C.border).stroke();doc.restore();
        doc.font('Helvetica').fontSize(9).fillColor(C.lightG).text(lbl2,c2x,y+10,{width:cuotaW,align:'center',lineBreak:false});
        doc.font('Helvetica-Bold').fontSize(20).fillColor(C.black).text(`$${(total/div2).toFixed(2)}`,c2x,y+24,{width:cuotaW,align:'center',lineBreak:false});
        doc.font('Helvetica').fontSize(8).fillColor(C.lightG).text('por mes',c2x,y+46,{width:cuotaW,align:'center',lineBreak:false});
        y+=cuotaH+24;
      }
      if(options.showPMs&&payMethods.length){
        checkPage(60); doc.font('Helvetica-Bold').fontSize(9).fillColor(C.grey).text('MÉTODOS DE PAGO',LM,y); y+=14;
        const pmPerRow=3,pmW=(W-(pmPerRow-1)*10)/pmPerRow,pmH=40; let pmRowY=y;
        payMethods.forEach((pm,pi)=>{ const col=pi%pmPerRow; if(col===0&&pi>0){pmRowY+=pmH+8;checkPage(pmH+8);} const pmX=LM+col*(pmW+10); doc.save();doc.roundedRect(pmX,pmRowY,pmW,pmH,6).fill(C.bg);doc.restore(); const logoBuf=parseBase64Image(pm.logo_base64); let textX=pmX+10; if(logoBuf){try{doc.image(logoBuf,pmX+8,pmRowY+8,{height:24,fit:[40,24]});textX=pmX+52;}catch{}} doc.font('Helvetica-Bold').fontSize(9).fillColor(C.black).text(pm.name||'',textX,pmRowY+10,{width:pmW-(textX-pmX)-8}); if(pm.description)doc.font('Helvetica').fontSize(7).fillColor(C.lightG).text(pm.description,textX,pmRowY+24,{width:pmW-(textX-pmX)-8}); });
        y=pmRowY+pmH+12;
      }
      if(q.notes){checkPage(50);const noteContent=`Notas: ${q.notes}`,notesH=doc.font('Helvetica').fontSize(10).heightOfString(noteContent,{width:W-28})+20;doc.save();doc.roundedRect(LM,y,W,notesH,6).fill(C.bg);doc.restore();doc.font('Helvetica-Bold').fontSize(10).fillColor(C.grey).text('Notas:',LM+14,y+8);doc.font('Helvetica').fontSize(10).fillColor(C.grey).text(q.notes,LM+56,y+8,{width:W-78,lineGap:3});y+=notesH+8;}
      const footNotes=q.footNotes||q.foot_notes||'';
      if(footNotes){checkPage(40);drawLine(LM,y,LM+W,C.border,0.5);y+=10;doc.font('Helvetica').fontSize(9).fillColor(C.lightG).text(footNotes,LM,y,{width:W,lineGap:4});y+=doc.heightOfString(footNotes,{width:W})+10;}
      checkPage(30); drawLine(LM,y,LM+W,C.border,0.5); y+=10;
      doc.font('Helvetica').fontSize(9).fillColor(C.lightG).text('• Precios en USD',LM,y); y+=12;
      if(options.showCuotasPDF){doc.text('• Cuotas con tarjetas participantes',LM,y);y+=12;}
      doc.text(`• ${validText} a partir de emisión`,LM,y);
      doc.font('Helvetica').fontSize(9).fillColor(C.lightG).text(q.qNum||'',LM+W-120,y,{width:120,align:'right'});
      doc.end();
    } catch(err){ reject(err); }
  });
}

// ── AUTH ──────────────────────────────────────────────────────────────────
router.post('/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error:'Email y contraseña requeridos' });
    const admin = getAdminByEmail(email);
    if (!admin || !bcrypt.compareSync(password, admin.password))
      return res.status(401).json({ error:'Credenciales incorrectas' });
    const token = jwt.sign({ id:admin.id, email:admin.email, name:admin.name }, process.env.JWT_SECRET, { expiresIn:'8h' });
    if (req.session) req.session.adminToken = token;
    res.json({ token, admin:{ email:admin.email, name:admin.name } });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post('/auth/logout', (req, res) => { req.session.adminToken = null; res.json({ ok:true }); });

// ── UPLOAD ────────────────────────────────────────────────────────────────
router.post('/upload', requireAdminAPI, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error:'No se recibió imagen' });
  try {
    const url = await uploadToStorage(req.file.buffer, req.file.originalname, 'uploads');
    res.json({ url });
  } catch(e) { res.status(500).json({ error:'Error al subir imagen' }); }
});

router.post('/products/import', requireAdminAPI, excelUpload.single('catalogo'), async (req, res) => {
  let filePath = '';
  try {
    if (!req.file) return res.status(400).json({ error:'Debes subir un archivo Excel' });
    filePath = req.file.path;
    const hideMissing = String(req.body.hideMissing||'0')==='1';
    const importKind  = String(req.body.importKind||'catalog').toLowerCase();
    const result = importKind==='inventory'
      ? await importInventoryWorkbook(filePath,{sourceFileName:req.file.originalname})
      : await importCatalogFromWorkbook(filePath,{hideMissing,sourceFileName:req.file.originalname});
    res.json(result);
  } catch(e) { res.status(500).json({ error:e.message }); }
  finally { if(filePath&&fs.existsSync(filePath)) try{fs.unlinkSync(filePath);}catch{} }
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────
router.get('/products', (req, res) => {
  try {
    let prods = getAllProducts();
    if (req.query.category) prods = prods.filter(p => p.category === req.query.category);
    if (req.query.featured)  prods = prods.filter(p => p.featured);
    if (!req.query.all)      prods = prods.filter(p => p.active !== false);
    res.json(prods);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get('/products/:id', (req, res) => {
  try {
    let product = getProductById(req.params.id);
    if (!product) product = getProductBySlug(req.params.id);
    if (!product) return res.status(404).json({ error:'No encontrado' });
    res.json(product);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post('/products', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const name  = cleanText(req.body.name, 160);
    const price = toNumber(req.body.price, NaN);
    if (!name || !Number.isFinite(price) || price <= 0) return badRequest(res, 'Nombre y precio válidos son requeridos');

    let image_url = cleanText(req.body.image_url, 2000);
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'products');

    const payload = {
      name, slug: slugify(name),
      description: cleanText(req.body.description, 5000),
      price, original_price: req.body.original_price!==undefined&&req.body.original_price!==''?toNumber(req.body.original_price,null):null,
      category: cleanText(req.body.category||'accesorios',80),
      badge: cleanText(req.body.badge,120)||null,
      featured: toBool(req.body.featured,false) ? 1 : 0,
      active: req.body.active!=='0' ? 1 : 0,
      stock: Math.max(0,parseInt(req.body.stock,10)||0),
      sort_order: Math.max(0,parseInt(req.body.sort_order,10)||0),
      enable_installments: req.body.enable_installments!==undefined ? (req.body.enable_installments!=='0'?1:0) : 1,
      image_url, img_fit: cleanText(req.body.img_fit||'contain',30), img_pos: cleanText(req.body.img_pos||'center',30),
      img_scale: Math.max(0.2,Math.min(3,toNumber(req.body.img_scale,1))),
      detail_img_scale: Math.max(0.2,Math.min(3,toNumber(req.body.detail_img_scale,toNumber(req.body.img_scale,1)))),
      color_variants: parseJsonField(req.body.color_variants,[]),
      variants: parseJsonField(req.body.variants,[]),
      logos: parseJsonField(req.body.logos,[]),
      ficha_tecnica: cleanText(req.body.ficha_tecnica,12000),
      ficha: parseJsonField(req.body.ficha,{}),
    };

    const ref = insertProduct(payload);
    res.status(201).json({ id:ref.id, slug:payload.slug });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.put('/products/:id', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const ex = getProductById(req.params.id);
    if (!ex) return res.status(404).json({ error:'No encontrado' });

    let image_url = req.body.image_url!==undefined ? cleanText(req.body.image_url,2000) : ex.image_url;
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'products');

    const name = cleanText(req.body.name,160)||ex.name;
    const payload = {
      name, slug: slugify(name),
      description: req.body.description!==undefined?cleanText(req.body.description,5000):(ex.description||''),
      price: req.body.price!==undefined&&req.body.price!==''?toNumber(req.body.price,ex.price):ex.price,
      original_price: req.body.original_price!==undefined?(req.body.original_price===''?null:toNumber(req.body.original_price,ex.original_price||null)):(ex.original_price||null),
      category: req.body.category!==undefined?cleanText(req.body.category,80):ex.category,
      badge: req.body.badge!==undefined?(cleanText(req.body.badge,120)||null):(ex.badge||null),
      featured: req.body.featured!==undefined?(toBool(req.body.featured,false)?1:0):(ex.featured?1:0),
      active: req.body.active!==undefined?(req.body.active!=='0'?1:0):(ex.active?1:0),
      stock: req.body.stock!==undefined?Math.max(0,parseInt(req.body.stock,10)||0):(ex.stock||0),
      sort_order: req.body.sort_order!==undefined?Math.max(0,parseInt(req.body.sort_order,10)||0):(ex.sort_order||0),
      image_url,
      img_fit: req.body.img_fit!==undefined?cleanText(req.body.img_fit,30):(ex.img_fit||'contain'),
      img_pos: req.body.img_pos!==undefined?cleanText(req.body.img_pos,30):(ex.img_pos||'center'),
      img_scale: req.body.img_scale!==undefined?Math.max(0.2,Math.min(3,toNumber(req.body.img_scale,ex.img_scale||1))):(ex.img_scale||1),
      detail_img_scale: req.body.detail_img_scale!==undefined?Math.max(0.2,Math.min(3,toNumber(req.body.detail_img_scale,ex.detail_img_scale||1))):(ex.detail_img_scale||1),
      color_variants: req.body.color_variants!==undefined?parseJsonField(req.body.color_variants,[]):(ex.color_variants||[]),
      variants: req.body.variants!==undefined?parseJsonField(req.body.variants,[]):(ex.variants||[]),
      logos: req.body.logos!==undefined?parseJsonField(req.body.logos,[]):(ex.logos||[]),
      specs: req.body.specs!==undefined?parseJsonField(req.body.specs,{}):(ex.specs||{}),
      ficha_tecnica: req.body.ficha_tecnica!==undefined?cleanText(req.body.ficha_tecnica,12000):(ex.ficha_tecnica||''),
      ficha: req.body.ficha!==undefined?parseJsonField(req.body.ficha,{}):(ex.ficha||{}),
    };

    updateProduct(req.params.id, payload);
    res.json({ ok:true, slug:payload.slug });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.delete('/products/:id', requireAdminAPI, (req, res) => {
  try { deleteProduct(req.params.id); res.json({ ok:true }); } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post('/products/bulk-delete', requireAdminAPI, (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error:'No se recibieron productos para eliminar' });
    ids.forEach(id => deleteProduct(id));
    res.json({ ok:true, affected:ids.length });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── INVENTORY ENTRIES ─────────────────────────────────────────────────────
router.get('/inventory-entries', requireAdminAPI, (req, res) => {
  try { res.json(getAllInventoryEntries(100)); } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post('/inventory-entries/:id/cancel', (req, res) => {
  try {
    const entry = getInventoryEntryById(req.params.id);
    if (!entry) return res.status(404).json({ error:'Ingreso no encontrado' });
    if (entry.status==='cancelled') return res.status(400).json({ error:'Este ingreso ya fue anulado' });

    const items = Array.isArray(entry.items) ? entry.items : [];
    for (const item of items) {
      if (!item.productId) continue;
      const p = getProductById(item.productId);
      if (!p) continue;
      const restoreStock = Math.max(0, Number(item.previousStock ?? 0));
      updateProduct(item.productId, {
        stock: restoreStock,
        active: item.createdProduct ? 0 : (item.previousActive!==false ? 1 : 0),
        last_entry_cancelled_at: new Date().toISOString(),
      });
    }

    updateInventoryEntry(req.params.id, { status:'cancelled', cancelledAt:new Date().toISOString() });
    res.json({ ok:true, reverted:items.length });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── CATEGORIES ────────────────────────────────────────────────────────────
router.get('/categories', (req, res) => {
  try { res.json(getAllCategories({ active:true })); } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post('/categories', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const { name, description, sort_order, bg_color } = req.body;
    if (!name) return res.status(400).json({ error:'Nombre requerido' });
    let image_url = req.body.image_url || '';
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'categories');
    const ref = insertCategory({ name, slug:slugify(name), description:description||'', sort_order:parseInt(sort_order)||0, bg_color:bg_color||'', image_url });
    clearCache();
    res.status(201).json({ id:ref.id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.put('/categories/:id', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const ex = dbGet('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    if (!ex) return res.status(404).json({ error:'No encontrado' });
    const { name, description, sort_order, active, bg_color, share_whatsapp } = req.body;
    let image_url = ex.image_url;
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'categories');
    else if (req.body.image_url && req.body.image_url.trim()) image_url = req.body.image_url.trim();
    updateCategory(req.params.id, {
      name: name||ex.name, description:description||'', image_url:image_url||ex.image_url||'',
      sort_order: parseInt(sort_order)||0, bg_color:bg_color||ex.bg_color||'',
      share_whatsapp: share_whatsapp!==undefined?(share_whatsapp!=='0'?1:0):(ex.share_whatsapp?1:0),
      active: active!==undefined?(active!=='0'?1:0):(ex.active?1:0),
    });
    clearCache();
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.delete('/categories/:id', requireAdminAPI, (req, res) => {
  try { deleteCategory(req.params.id); clearCache(); res.json({ ok:true }); } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── BANNERS ───────────────────────────────────────────────────────────────
router.get('/banners', (req, res) => {
  try {
    const all = getAllBanners();
    res.json(req.query.all ? all : all.filter(b => b.active!==false));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post('/banners', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const { title, subtitle, cta_text, cta_url, bg_color, text_color, sort_order } = req.body;
    let image_url = req.body.image_url||'';
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'products');
    const ref = insertBanner({ title:title||'', subtitle:subtitle||'', cta_text:cta_text||'', cta_url:cta_url||'', image_url, bg_color:bg_color||'#1d1d1f', text_color:text_color||'#ffffff', sort_order:parseInt(sort_order)||0 });
    res.status(201).json({ id:ref.id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.put('/banners/:id', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const ex = dbGet('SELECT * FROM banners WHERE id = ?', [req.params.id]);
    if (!ex) return res.status(404).json({ error:'No encontrado' });
    const { title, subtitle, cta_text, cta_url, bg_color, text_color, active, sort_order } = req.body;
    let image_url = req.body.image_url||ex.image_url;
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'products');
    updateBanner(req.params.id, { title:title||ex.title||'', subtitle:subtitle||ex.subtitle||'', cta_text:cta_text||ex.cta_text||'', cta_url:cta_url||ex.cta_url||'', image_url:image_url||'', bg_color:bg_color||ex.bg_color||'#1d1d1f', text_color:text_color||ex.text_color||'#ffffff', active:active!==undefined?(active==='1'?1:0):(ex.active?1:0), sort_order:parseInt(sort_order)||0 });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.delete('/banners/:id', requireAdminAPI, (req, res) => {
  try { deleteBanner(req.params.id); res.json({ ok:true }); } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── SETTINGS ──────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  try { res.json(getSettings()); } catch(e) { res.status(500).json({ error:e.message }); }
});

router.put('/settings/sellers', requireAdminAPI, (req, res) => {
  try {
    const sellers       = Array.isArray(req.body.sellers) ? req.body.sellers : [];
    const cuota_logos   = Array.isArray(req.body.cuota_logos) ? req.body.cuota_logos : [];
    const cuotas_active = req.body.cuotas_active!==undefined ? !!req.body.cuotas_active : true;
    setSettings({ sellers, cuota_logos, cuotas_active });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.put('/settings', requireAdminAPI, upload.single('logo'), async (req, res) => {
  try {
    const updates = { ...req.body };
    if (req.file) updates.logo_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'logos');
    if (updates.promo_bar_active!==undefined)      updates.promo_bar_active      = updates.promo_bar_active==='1';
    if (updates.auth_section_active!==undefined)   updates.auth_section_active   = updates.auth_section_active==='1';
    if (updates.auth_hero_badge_active!==undefined) updates.auth_hero_badge_active = updates.auth_hero_badge_active==='1';
    if (updates.support_section_active!==undefined) updates.support_section_active = updates.support_section_active==='1';
    if (updates.show_ramiro!==undefined)           updates.show_ramiro           = updates.show_ramiro==='1';
    if (updates.ramiro_show_source!==undefined)    updates.ramiro_show_source    = updates.ramiro_show_source==='1';
    if (updates.show_admin_icon!==undefined)       updates.show_admin_icon       = updates.show_admin_icon==='1';
    if (updates.support_cards) try{updates.support_cards=JSON.parse(updates.support_cards);}catch{delete updates.support_cards;}
    if (updates.footer_cols)   try{updates.footer_cols=JSON.parse(updates.footer_cols);}catch{delete updates.footer_cols;}
    delete updates.sellers;
    setSettings(updates);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get('/site-version', (req, res) => {
  try { const s=getSettings(); res.json({ version:s.site_version||1 }); } catch{ res.json({ version:1 }); }
});

router.post('/site-version/bump', requireAdminAPI, (req, res) => {
  try { const v=Date.now(); setSettings({ site_version:v }); res.json({ ok:true, version:v }); } catch(e){ res.status(500).json({ error:e.message }); }
});

// ── ANNOUNCEMENTS ─────────────────────────────────────────────────────────
router.get('/announcements', (req, res) => {
  try {
    const all = getAllAnnouncements();
    res.json(req.query.all ? all : all.filter(a=>a.active!==false));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post('/announcements', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const { title, link, sort_order, logo_height } = req.body;
    let image_url = req.body.image_url||'';
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'banners');
    const ref = insertAnnouncement({ title:title||'', link:link||'', image_url, sort_order:parseInt(sort_order)||0, logo_height:parseInt(logo_height)||64 });
    res.status(201).json({ id:ref.id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.put('/announcements/:id', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const ex = dbGet('SELECT * FROM announcements WHERE id = ?', [req.params.id]);
    if (!ex) return res.status(404).json({ error:'No encontrado' });
    const { title, link, sort_order, logo_height } = req.body;
    let image_url = req.body.image_url!==undefined ? req.body.image_url : ex.image_url;
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'announcements');
    updateAnnouncement(req.params.id, { title:title||ex.title||'', link:link||'', image_url:image_url||'', sort_order:parseInt(sort_order)||0, logo_height:parseInt(logo_height)||64 });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post('/announcements/:id/toggle', requireAdminAPI, (req, res) => {
  try {
    const ex = dbGet('SELECT active FROM announcements WHERE id = ?', [req.params.id]);
    if (!ex) return res.status(404).json({ error:'No encontrado' });
    updateAnnouncement(req.params.id, { active: ex.active===0 ? 1 : 0 });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.delete('/announcements/:id', requireAdminAPI, (req, res) => {
  try { deleteAnnouncement(req.params.id); res.json({ ok:true }); } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── PAYMENT METHODS ───────────────────────────────────────────────────────
router.get('/payment-methods', (req, res) => {
  try { res.json(getAllPaymentMethods()); } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post('/payment-methods', requireAdminAPI, upload.single('logo'), async (req, res) => {
  try {
    const { name, description, sort_order } = req.body;
    if (!name) return res.status(400).json({ error:'Nombre requerido' });
    let logo_url = req.body.logo_url||'';
    if (req.file) logo_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'logos');
    const ref = insertPaymentMethod({ name, description:description||'', logo_url, sort_order:parseInt(sort_order)||0 });
    res.status(201).json({ id:ref.id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.put('/payment-methods/:id', requireAdminAPI, upload.single('logo'), async (req, res) => {
  try {
    const ex = dbGet('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
    if (!ex) return res.status(404).json({ error:'No encontrado' });
    const { name, description, sort_order, active } = req.body;
    let logo_url = req.body.logo_url!==undefined ? req.body.logo_url : ex.logo_url;
    if (req.file) logo_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'logos');
    updatePaymentMethod(req.params.id, { name:name||ex.name, description:description||'', logo_url, sort_order:parseInt(sort_order)||0, active:active!=='0'?1:0 });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.delete('/payment-methods/:id', requireAdminAPI, (req, res) => {
  try { deletePaymentMethod(req.params.id); res.json({ ok:true }); } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── QUOTATIONS ────────────────────────────────────────────────────────────
router.get('/quotations', requireAdminAPI, (req, res) => {
  try {
    let quotes = getAllQuotations(500);
    const { client, company, seller, product, from, to, ivaMode } = req.query;
    if (client)  quotes = quotes.filter(q=>(q.client||'').toLowerCase().includes(client.toLowerCase()));
    if (company) quotes = quotes.filter(q=>(q.company||'').toLowerCase().includes(company.toLowerCase()));
    if (seller)  quotes = quotes.filter(q=>(q.seller||'').toLowerCase().includes(seller.toLowerCase()));
    if (product) quotes = quotes.filter(q=>(q.items||[]).some(i=>(i.name||'').toLowerCase().includes(product.toLowerCase())));
    if (ivaMode) quotes = quotes.filter(q=>q.ivaMode===ivaMode);
    if (from) { const d=new Date(from); quotes=quotes.filter(q=>q.createdAt&&new Date(q.createdAt)>=d); }
    if (to)   { const d=new Date(to); d.setHours(23,59,59); quotes=quotes.filter(q=>q.createdAt&&new Date(q.createdAt)<=d); }
    res.json(quotes);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post('/quotations', requireAdminAPI, (req, res) => {
  try {
    const { client, company, seller, notes, validity, ivaMode, items, total, lbl1, lbl2, div1, div2, qNum, client_phone, client_email, foot_notes } = req.body;
    if (!client&&!company) return res.status(400).json({ error:'Ingresa al menos cliente o empresa' });
    const ref = insertQuotation({ client:client||'', company:company||'', seller:seller||'', notes:notes||'', validity:String(validity||'7'), ivaMode:ivaMode||'con', items:Array.isArray(items)?items:[], total:parseFloat(total)||0, lbl1:lbl1||'6 cuotas', lbl2:lbl2||'10 cuotas', div1:parseInt(div1)||6, div2:parseInt(div2)||10, qNum:qNum||'', client_phone:client_phone||'', client_email:client_email||'', foot_notes:foot_notes||'' });
    res.status(201).json({ id:ref.id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post('/quotations/export-pdf', async (req, res) => {
  try {
    const { client, company, seller, notes, validity, ivaMode, items, total, lbl1, lbl2, div1, div2, qNum, client_phone, client_email, foot_notes, footNotes, saveHistory, settings, options, paymentMethods } = req.body;
    if (!client&&!company) return res.status(400).json({ error:'Ingresa al menos cliente o empresa' });

    const quotation = { client:client||'', company:company||'', seller:seller||'', notes:notes||'', validity:String(validity||'7'), ivaMode:ivaMode||'con', items:Array.isArray(items)?items:[], total:parseFloat(total)||0, lbl1:lbl1||'6 cuotas sin intereses', lbl2:lbl2||'10 cuotas sin intereses', div1:parseInt(div1)||6, div2:parseInt(div2)||10, qNum:qNum||('COT-'+Date.now().toString().slice(-6)), client_phone:client_phone||'', client_email:client_email||'', foot_notes:foot_notes||'', footNotes:footNotes||foot_notes||'', settings:settings||{}, options:options||{}, paymentMethods:Array.isArray(paymentMethods)?paymentMethods:[], createdAt:new Date() };

    if (saveHistory!==false) {
      try {
        insertQuotation({ client:quotation.client, company:quotation.company, seller:quotation.seller, notes:quotation.notes, validity:quotation.validity, ivaMode:quotation.ivaMode, items:quotation.items.map(i=>({name:i.name,price:i.price,qty:i.qty,discount:i.discount||0,variant:i.variant||'',specs:i.specs||{},image_url:i.image_url||''})), total:quotation.total, lbl1:quotation.lbl1, lbl2:quotation.lbl2, div1:quotation.div1, div2:quotation.div2, qNum:quotation.qNum, client_phone:quotation.client_phone, client_email:quotation.client_email, foot_notes:quotation.footNotes });
      } catch(e) { console.warn('No se pudo guardar historial:', e.message); }
    }

    if (!quotation.footNotes) {
      try { const s=getSettings(); if(s.pdf_foot_notes) quotation.footNotes=s.pdf_foot_notes; } catch{}
    }

    const pdfBuffer = await buildPdfBuffer(quotation);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="${quotation.qNum}.pdf"`);
    res.send(pdfBuffer);
  } catch(e) { console.error('Error PDF:', e); res.status(500).json({ error:e.message }); }
});

router.get('/quotations/:id/pdf', requireAdminAPI, async (req, res) => {
  try {
    const data = getQuotationById(req.params.id);
    if (!data) return res.status(404).json({ error:'Cotización no encontrada' });
    const quotation = { ...data, options:data.options||{showSpecs:true,showFichaGlobal:false,showCuotasPDF:true,showPMs:false}, settings:data.settings||{}, paymentMethods:data.paymentMethods||[], footNotes:data.foot_notes||data.footNotes||'' };
    const pdfBuffer = await buildPdfBuffer(quotation);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="${quotation.qNum||'cotizacion'}.pdf"`);
    res.send(pdfBuffer);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.delete('/quotations/:id', requireAdminAPI, (req, res) => {
  try { deleteQuotation(req.params.id); res.json({ ok:true }); } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── SELLERS ───────────────────────────────────────────────────────────────
router.get('/sellers', (req, res) => {
  try {
    const data = getSettings();
    const sellers = Array.isArray(data.sellers) ? data.sellers : (typeof data.sellers==='string' ? JSON.parse(data.sellers||'[]') : []);
    res.json(sellers);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── CLIENTS AUTOCOMPLETE ──────────────────────────────────────────────────
router.get('/clients-public', requireAdminAPI, (req, res) => {
  try {
    const quotes = getAllQuotations(300);
    const seen   = new Map();
    quotes.forEach(q => {
      const key = (q.client||'').toLowerCase()+(q.company||'').toLowerCase();
      if (key&&!seen.has(key)) seen.set(key,{ client:q.client||'', company:q.company||'', phone:q.client_phone||'' });
    });
    res.json([...seen.values()]);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── EDITOR VISUAL ─────────────────────────────────────────────────────────
const VIEWS_DIR = ppath.join(__dirname, '../views');

async function renderPageForEditor(pageName) {
  const settings      = getSettings() || {};
  const categories    = getAllCategories({ active: true });
  const announcements = getAllAnnouncements().filter(a => a.active !== false);
  const fmtPrice      = p => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(p||0);
  const fakeReq       = { session:{}, query:{} };
  const opts          = { views:[VIEWS_DIR, ppath.join(VIEWS_DIR,'partials')] };

  const base = { settings, categories, announcements, formatPrice: fmtPrice, req: fakeReq, vendorMode: false };

  if (pageName === 'home') {
    const banners  = getAllBanners({ active:true });
    const allProds = getAllProducts().filter(p => p.active !== false);
    const featured = allProds.slice(0, 12);
    const products = allProds.slice(0, 24);
    const saved    = getPageDesign('home');
    const editorCss = (saved && saved.css) ? saved.css : '';
    return ejs.renderFile(ppath.join(VIEWS_DIR,'home.ejs'), { ...base, banners, featured, products, editorCss, title: settings.store_name||'MacStore' }, opts);
  }
  if (pageName === 'catalog') {
    const products = getAllProducts().filter(p => p.active !== false);
    return ejs.renderFile(ppath.join(VIEWS_DIR,'catalog.ejs'), { ...base, products, title:'Catálogo' }, opts);
  }
  if (pageName === 'product') {
    const product = getAllProducts().filter(p=>p.active!==false)[0] || { id:'0', name:'Producto de ejemplo', price:999, description:'Descripción del producto.', slug:'ejemplo', image_url:'', category:'mac', specs:{}, color_variants:[], variants:[] };
    const related = getAllProducts().filter(p=>p.active!==false&&p.id!==product.id).slice(0,4);
    return ejs.renderFile(ppath.join(VIEWS_DIR,'product.ejs'), { ...base, product, related, title: product.name }, opts);
  }
  if (pageName === 'category') {
    const catWithImg = categories.find(c => c.image_url) || categories[0] || { id:'0', name:'Categoría', slug:'mac' };
    const products = getAllProducts().filter(p=>p.active!==false&&p.category===catWithImg.slug).slice(0,24);
    return ejs.renderFile(ppath.join(VIEWS_DIR,'category.ejs'), { ...base, category: catWithImg, products, title: catWithImg.name }, opts);
  }
  // ── Categoría específica: category-{slug}
  if (pageName.startsWith('category-')) {
    const slug = pageName.slice(9);
    const category = categories.find(c => c.slug === slug) || { id:'0', name: slug, slug };
    const products = getAllProducts().filter(p=>p.active!==false&&(p.category===slug||p.cat_slug===slug)).slice(0,48);
    return ejs.renderFile(ppath.join(VIEWS_DIR,'category.ejs'), { ...base, category, products, title: category.name }, opts);
  }
  // ── Producto específico: product-{slug}
  if (pageName.startsWith('product-')) {
    const slug = pageName.slice(8);
    const allProds = getAllProducts().filter(p=>p.active!==false);
    const product = allProds.find(p=>p.slug===slug) || allProds[0] || { id:'0', name:'Producto', price:0, slug, image_url:'', category:'', specs:{}, color_variants:[], variants:[] };
    const related = allProds.filter(p=>p.id!==product.id&&p.category===product.category).slice(0,4);
    return ejs.renderFile(ppath.join(VIEWS_DIR,'product.ejs'), { ...base, product, related, title: product.name }, opts);
  }
  throw new Error('Página no válida: ' + pageName);
}

async function rerenderSavedPages() {
  try {
    const designs = getAllPageDesigns();
    for (const d of designs) {
      if (!d.html || !d.html.trim()) continue;
      try {
        const freshHtml = await renderPageForEditor(d.page_name);
        savePageDesign(d.page_name, freshHtml, d.css || '', d.gjs_data || '{}');
      } catch (e) {
        console.warn('[rerenderSavedPages] skip', d.page_name, e.message);
      }
    }
  } catch (e) {
    console.error('[rerenderSavedPages] ERROR', e.message);
  }
}

router.get('/editor/render', requireAdminAPI, async (req, res) => {
  try {
    const html = await renderPageForEditor(req.query.page || 'home');
    res.send(html);
  } catch(e) { console.error('[editor/render] ERROR:', e.message, e.stack?.split('\n')[1]); res.status(500).json({ error: e.message }); }
});

router.get('/editor/design', requireAdminAPI, (req, res) => {
  try {
    const pageName = req.query.page || 'home';
    const d = getPageDesign(pageName);
    if (!d) return res.json(null);
    const html = d.html ? patchSavedHtml(pageName, d.html) : '';
    res.json({ html, css: d.css||'', gjsData: d.gjs_data||'{}', updatedAt: d.updatedAt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function stripBadHeroCss(input) {
  if (!input) return input;
  const badSelectors = [
    /\.?ms-hero-wrap\s*\{[^}]*(?:height|width)\s*:\s*\d+px[^}]*\}/g,
    /\.?ms-hero-overlay\s*\{[^}]*(height|width)\s*:\s*\d+px[^}]*\}/g,
    /\.?ms-hero-bg\s*\{[^}]*(height|width|color)\s*:[^}]*(?:\d+px|rgb\(1[0-9]{2})[^}]*\}/g,
    /\.?ms-hero-title\s*\{[^}]*color\s*:\s*rgb\(\s*1[0-9]{2}[^)]*\)[^}]*\}/g,
    /\.?(?:ms-slide\.)?hero-banner-slide(?:\.active)?\s*\{[^}]*(?:height|width)\s*:\s*\d+px[^}]*\}/g,
  ];
  let out = input;
  for (const re of badSelectors) out = out.replace(re, '');
  return out;
}

router.post('/editor/save', requireAdminAPI, (req, res) => {
  try {
    const { page, gjsData } = req.body;
    if (!page) return res.status(400).json({ error:'Falta page' });
    const cleanCss  = stripBadHeroCss(req.body.css || '');
    const cleanHtml = (req.body.html || '').replace(/<style[^>]*>([\s\S]*?)<\/style>/gi,
      (m, s) => m.replace(s, stripBadHeroCss(s)));
    savePageDesign(page, cleanHtml, cleanCss, gjsData||'{}');
    clearCache();
    // Sincronizar tamaño del logo a todas las páginas guardadas
    const logoStyle = extractLogoStyle(cleanHtml);
    if (logoStyle) {
      setSettings({ global_logo_style: logoStyle });
      setImmediate(persistPatches);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/editor/save-all', requireAdminAPI, async (req, res) => {
  try {
    // Páginas base siempre incluidas
    const pages = new Set(['home', 'catalog']);
    // Todas las categorías activas
    getAllCategories({ active: true }).forEach(c => { if (c.slug) pages.add('category-' + c.slug); });
    // Todos los productos activos
    getAllProducts({ active: true }).forEach(p => { if (p.slug) pages.add('product-' + p.slug); });

    const saved = [], errors = [];
    for (const pageName of pages) {
      try {
        const existing = getPageDesign(pageName);
        let finalHtml;
        if (existing?.html?.trim()) {
          // Preservar diseño del editor — solo re-parchear datos dinámicos
          finalHtml = patchSavedHtml(pageName, existing.html);
        } else {
          // Sin diseño guardado: inicializar desde EJS
          finalHtml = await renderPageForEditor(pageName);
        }
        const cleanHtml = (finalHtml||'').replace(/<style[^>]*>([\s\S]*?)<\/style>/gi,
          (m, s) => m.replace(s, stripBadHeroCss(s)));
        savePageDesign(pageName, cleanHtml, stripBadHeroCss(existing?.css||''), existing?.gjs_data||'{}');
        saved.push(pageName);
      } catch(e) { errors.push({ page: pageName, error: e.message }); }
    }
    clearCache();
    res.json({ ok: true, saved, errors });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CSS GLOBAL ───────────────────────────────────────────────────────────
router.get('/editor/global-css', requireAdminAPI, (_req, res) => {
  try {
    res.json({ css: getSettings().global_css || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/editor/global-css', requireAdminAPI, (req, res) => {
  try {
    setSettings({ global_css: String(req.body.css || '') });
    setImmediate(persistPatches);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EXPORTAR Y PUBLICAR EN GODADDY ───────────────────────────────────────
router.get('/deploy', requireAdminAPI, async (req, res) => {
  // Streaming SSE para mostrar progreso en tiempo real
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    send({ type: 'step', msg: 'Generando archivos estáticos...' });
    await exportSite();

    send({ type: 'step', msg: 'Conectando con GoDaddy por FTP...' });
    const result = await deployToGodaddy((evt) => {
      if (evt.type === 'connected') send({ type: 'step', msg: `Subiendo ${evt.total} archivo(s) nuevos o modificados...` });
      if (evt.type === 'progress') send({ type: 'progress', uploaded: evt.uploaded, total: evt.total, file: evt.file });
    });

    send({ type: 'done', uploaded: result.uploaded, skipped: result.skipped, total: result.total });
  } catch(e) {
    console.error('[deploy]', e.message);
    send({ type: 'error', msg: e.message });
  } finally {
    res.end();
  }
});

// ── EXPORTAR SITIO ESTÁTICO ───────────────────────────────────────────────
const LATEST_DIR = require('path').join(__dirname, '../exports/latest');

router.post('/export', requireAdminAPI, async (req, res) => {
  const mode = (req.query.mode || req.body.mode || 'guardar').toLowerCase();
  try {
    const { outDir, stats } = await exportSite();
    if (mode === 'publicar') {
      const zipPath = `${outDir}.zip`;
      createZip(outDir, zipPath);
      const zipName = `macstore-${stats.timestamp}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      const stream = fs.createReadStream(zipPath);
      stream.pipe(res);
      stream.on('end', () => { try { fs.unlinkSync(zipPath); } catch {} });
    } else {
      res.json({ ok: true, message: 'Sitio guardado correctamente', stats, folder: LATEST_DIR });
    }
  } catch(e) { console.error('[export]', e); res.status(500).json({ error: e.message }); }
});

router.post('/export/open-folder', requireAdminAPI, (req, res) => {
  try {
    require('child_process').exec(`open "${LATEST_DIR}"`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/export/bundle', requireAdminAPI, async (req, res) => {
  try {
    const { latestDir, stats } = await exportSite();
    const files = [];
    function walk(dir, rel) {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        const full = require('path').join(dir, name);
        const relPath = rel ? rel + '/' + name : name;
        if (fs.statSync(full).isDirectory()) { walk(full, relPath); }
        else { files.push({ path: relPath, content: fs.readFileSync(full, 'utf8') }); }
      }
    }
    walk(latestDir, '');
    res.json({ ok: true, stats, files });
  } catch(e) { console.error('[bundle]', e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
