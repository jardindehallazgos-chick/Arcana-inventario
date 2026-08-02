
// ── FIREBASE REST API (no SDK needed) ────────────────────────────────────────
console.log('ARCANA SCRIPT LOADED');
var FB_API_KEY = "AIzaSyCj5K7yECCbVFtX2wo_7xgO-pYizIGoiXo";
var FB_PROJECT = "arcana-vintage";
var FB_BASE = "https://firestore.googleapis.com/v1/projects/"+FB_PROJECT+"/databases/(default)/documents/arcana/datos";
var syncTimeout = null;
var _lastKnownUpdated = null; // sello de tiempo del ultimo dato conocido (optimizacion de polling)
var lastSavedHash = "";
var isLocalChange = false;
var listenerActive = false;

// Generate a simple hash to detect real changes
function hashDB(){
  var s = JSON.stringify({items:DB.items, provs:DB.provs, ventas:DB.ventas, apartados:DB.apartados, saldos:DB.saldos, archivo:DB.archivo});
  var h = 0;
  for(var i=0;i<s.length;i++){ h = ((h<<5)-h)+s.charCodeAt(i); h|=0; }
  return String(h);
}

// Real-time listener using Firestore REST long-polling
function startListener(){
  if(listenerActive) return;
  listenerActive = true;
  pollFirestore();
}

function pollFirestore(){
  if(!listenerActive) return;
  // Poll every 8 seconds for changes
  setTimeout(function(){
    // OPTIMIZACION: primero pedir SOLO el campo "updated" (peticion ligera, sin
    // items/ventas/etc). Si coincide con el ultimo conocido, no hay nada que
    // hacer y nos ahorramos descargar y comparar toda la base de datos.
    // Si Firestore no soporta la mascara o algo falla, se cae automaticamente
    // a la comparacion completa de siempre (nunca se pierde un cambio remoto).
    fetch(FB_BASE+"?key="+FB_API_KEY+"&mask.fieldPaths=updated")
      .then(function(r){ return r.json(); })
      .then(function(doc){
        var remoteUpdated = (doc.fields && doc.fields.updated && doc.fields.updated.stringValue) || null;
        if(remoteUpdated && _lastKnownUpdated && remoteUpdated===_lastKnownUpdated && !isLocalChange){
          // Sin cambios remotos: nos ahorramos la comparacion pesada.
          isLocalChange = false;
          pollFirestore();
          return;
        }
        // Hay cambio (o es la primera vez, o el atajo no aplico): hacer la
        // comparacion completa, exactamente como antes.
        pollFirestoreCompleto(remoteUpdated);
      })
      .catch(function(){
        // Si la peticion ligera falla, intentar igual con la comparacion completa
        // antes de rendirse (no dejar de sincronizar por un fallo de la mascara).
        pollFirestoreCompleto(null);
      });
  }, 8000);
}
function pollFirestoreCompleto(knownUpdated){
    fetch(FB_BASE+"?key="+FB_API_KEY)
      .then(function(r){ return r.json(); })
      .then(function(doc){
        if(doc.fields && !isLocalChange){
          var d = fromFB({mapValue:{fields:doc.fields}});
          if(d&&d.items&&d.provs){
            // Temporarily load remote to get its hash
            var tempDB = {items:d.items, provs:d.provs, ventas:d.ventas||[], apartados:d.apartados||[], saldos:d.saldos||[], archivo:d.archivo||[], config:d.config||{accessPass:ACCESS_PASS_DEFAULT,adminPass:ADMIN_PASS_DEFAULT,logo:""}};
            _itemIndex=null; _provIndex=null;
            var tempHash = JSON.stringify(tempDB);
            var localHash = JSON.stringify({items:DB.items, provs:DB.provs, ventas:DB.ventas, apartados:DB.apartados, saldos:DB.saldos, archivo:DB.archivo, config:DB.config});
            if(tempHash !== localHash){
              // Remote data differs from local - update
              DB = tempDB;
              try{ localStorage.setItem("vnt", JSON.stringify(DB)); }catch(e){}
              // Refresh current visible tab without losing position
              refreshCurrentTab();
              applyConfig();
              fbStatus("Actualizado desde otro dispositivo", "#818cf8");
              setTimeout(function(){ fbStatus("Conectado", "#4ade80"); }, 2500);
            }
          }
          _lastKnownUpdated = (d && d.updated) || knownUpdated || null;
        }
        isLocalChange = false;
        pollFirestore(); // Schedule next poll
      })
      .catch(function(){
        listenerActive = false;
        fbStatus("Sin conexion - reintentando...", "#f59e0b");
        // Retry listener after 15 seconds
        setTimeout(function(){
          listenerActive = false;
          startListener();
        }, 15000);
      });
}

function refreshCurrentTab(){
  var tabs = ["inventario","pos","proveedores","reportes","etiq-pub"];
  for(var i=0;i<tabs.length;i++){
    var el = document.getElementById("tab-"+tabs[i]);
    if(el && el.classList.contains("on")){
      if(tabs[i]==="inventario") RI();
      else if(tabs[i]==="pos") PH();
      else if(tabs[i]==="proveedores") RP();
      else if(tabs[i]==="reportes") RR();
      else if(tabs[i]==="etiq-pub") EPB();
      break;
    }
  }
}

function fbStatus(msg, color){
  var el = document.getElementById("sync-status");
  if(el){ el.textContent = msg; el.style.color = color; }
}

// Convert JS object to Firestore REST format
function toFB(val){
  if(val === null || val === undefined) return {nullValue: null};
  if(typeof val === "boolean") return {booleanValue: val};
  if(typeof val === "number") return {doubleValue: val};
  if(typeof val === "string") return {stringValue: val};
  if(Array.isArray(val)){
    return {arrayValue:{values: val.map(function(v){ return toFB(v); })}};
  }
  if(typeof val === "object"){
    var fields = {};
    for(var k in val) if(val.hasOwnProperty(k)) fields[k] = toFB(val[k]);
    return {mapValue:{fields: fields}};
  }
  return {stringValue: String(val)};
}

// Convert Firestore REST format back to JS object
function fromFB(fbVal){
  if(!fbVal) return null;
  if("nullValue" in fbVal) return null;
  if("booleanValue" in fbVal) return fbVal.booleanValue;
  if("doubleValue" in fbVal) return fbVal.doubleValue;
  if("integerValue" in fbVal) return parseInt(fbVal.integerValue);
  if("stringValue" in fbVal) return fbVal.stringValue;
  if("arrayValue" in fbVal){
    var arr = fbVal.arrayValue.values || [];
    return arr.map(function(v){ return fromFB(v); });
  }
  if("mapValue" in fbVal){
    var obj = {}, fields = fbVal.mapValue.fields || {};
    for(var k in fields) obj[k] = fromFB(fields[k]);
    return obj;
  }
  return null;
}

function dbSave(){
  _itemIndex=null; _provIndex=null; // invalidar indices (datos cambiaron)
  isLocalChange = true; // Mark as local change to avoid echo
  try{ localStorage.setItem("vnt", JSON.stringify(DB)); }catch(e){}
  if(syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(function(){
    fbStatus("Guardando...", "#c9a96e");
    var body = JSON.stringify({fields:{
      items: toFB(DB.items),
      provs: toFB(DB.provs),
      ventas: toFB(DB.ventas),
      apartados: toFB(DB.apartados||[]),
      saldos: toFB(DB.saldos||[]),
      archivo: toFB(DB.archivo||[]),
      config: toFB(DB.config||{accessPass:ACCESS_PASS_DEFAULT,adminPass:ADMIN_PASS_DEFAULT,logo:""}),
      updated: toFB(new Date().toISOString())
    }});
    fetch(FB_BASE+"?key="+FB_API_KEY, {method:"PATCH", headers:{"Content-Type":"application/json"}, body:body})
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d.error){ fbStatus("Sin conexion (local)", "#f59e0b"); console.log("FB save error:", d.error); }
        else fbStatus("Sincronizado", "#4ade80");
      })
      .catch(function(e){ fbStatus("Sin conexion (local)", "#f59e0b"); });
  }, 1500);
}

function dbLoad(){
  console.log("dbLoad START");
  try{
    var d = JSON.parse(localStorage.getItem("vnt")||"{}");
    if(d&&d.items&&d.provs){ DB = d; _itemIndex=null; _provIndex=null; }
  }catch(e){ console.log("localStorage error:", e); }
  if(!DB.config) DB.config={accessPass:ACCESS_PASS_DEFAULT,adminPass:ADMIN_PASS_DEFAULT,logo:""};
  applyConfig();
  fbStatus("Conectando...", "#6b6358");
  console.log("FB_BASE:", FB_BASE);
  console.log("FB_API_KEY:", FB_API_KEY ? "present" : "missing");
  // Timeout: if no response in 8 seconds, show local mode
  var timeout = setTimeout(function(){
    fbStatus("Modo local (sin red)", "#f59e0b");
    console.log("FB timeout - no response after 8s");
  }, 8000);
  var url = FB_BASE + "?key=" + FB_API_KEY;
  console.log("Fetching:", url);
  fetch(url, {
    method: "GET",
    headers: {"Content-Type": "application/json"},
    mode: "cors"
  })
    .then(function(r){
      console.log("FB response status:", r.status, r.statusText);
      clearTimeout(timeout);
      return r.json();
    })
    .then(function(doc){
      console.log("FB doc:", JSON.stringify(doc).slice(0,200));
      if(doc.error){
        console.log("FB error:", doc.error.code, doc.error.message);
        if(doc.error.code === 404 || doc.error.status === "NOT_FOUND"){
          fbStatus("Primera vez - subiendo datos...", "#c9a96e");
          dbSave();
          setTimeout(startListener, 3000);
        } else if(doc.error.code === 403 || doc.error.status === "PERMISSION_DENIED"){
          fbStatus("Error permisos - revisa reglas Firestore", "#f87171");
        } else {
          fbStatus("Sin conexion - modo local", "#f59e0b");
        }
        return;
      }
      if(doc.fields){
        var d = fromFB({mapValue:{fields:doc.fields}});
        if(d&&d.items&&d.provs){
          DB = {items:d.items, provs:d.provs, ventas:d.ventas||[], apartados:d.apartados||[], saldos:d.saldos||[], archivo:d.archivo||[], config:d.config||{accessPass:ACCESS_PASS_DEFAULT,adminPass:ADMIN_PASS_DEFAULT,logo:""}};
          _itemIndex=null; _provIndex=null;
          detectarDuplicados(true); // red de seguridad: auto-reparar IDs duplicados
          try{ localStorage.setItem("vnt", JSON.stringify(DB)); }catch(e){}
          RI(); PH(); applyConfig();
          fbStatus("Conectado", "#4ade80");
          startListener(); // Start real-time sync
        } else {
          fbStatus("Conectado (datos vacios)", "#c9a96e");
          dbSave();
        }
      } else {
        fbStatus("Primera vez - subiendo datos...", "#c9a96e");
        dbSave();
      }
    })
    .catch(function(e){
      clearTimeout(timeout);
      console.log("FB fetch error:", e.name, e.message);
      fbStatus("Sin conexion - modo local", "#f59e0b");
    });
}

var CATS = ["Vestido","Blusa","Pantalon","Falda","Saco/Blazer","Abrigo","Sueter","Chaleco","Traje","Lenceria","Zapatos","Bolso/Cartera","Accesorio","Joyeria","Objeto decorativo","Bebida","Alimentos","Otro"];
var EPOCAS = ["1900s","1910s","1920s","1930s","1940s","1950s","1960s","1970s","1980s","1990s","2000s","2010s","2020s","Sin epoca definida"];
var TALLAS = ["Xch","Ch","Ch/M","M","M/G","G","XG"];
var ADMIN_PASS_DEFAULT = "arcana2024";
var ACCESS_PASS_DEFAULT = "JDH1";
function getAdminPass(){ return (DB.config&&DB.config.adminPass)||ADMIN_PASS_DEFAULT; }
function setAdminPass(v){ DB.config=DB.config||{}; DB.config.adminPass=v; dbSave(); }
function getAccessPass(){ return (DB.config&&DB.config.accessPass)||ACCESS_PASS_DEFAULT; }
function setAccessPass(v){ DB.config=DB.config||{}; DB.config.accessPass=v; dbSave(); }
var TABS_LIBRES = {"pos":true,"etiq-pub":true,"apartados":true};
var sessionAdmin = false;

var DB = {
  items:[
    {id:"d1",sku:"CV-001",descripcion:"Vestido floral demo",categoria:"Vestido",epoca:"1960s",cantidad:2,proveedorId:"p1",costoProveedor:350,precioVenta:1200,fechaIngreso:"2024-01-15",notas:"Dato de ejemplo"},
    {id:"d2",sku:"SR-001",descripcion:"Bolso piel demo",categoria:"Bolso/Cartera",epoca:"1980s",cantidad:0,proveedorId:"p2",costoProveedor:600,precioVenta:1800,fechaIngreso:"2024-02-01",notas:""}
  ],
  provs:[
    {id:"p1",nombre:"Proveedor Demo 1",tipo:"consignacion",telefono:"",notas:""},
    {id:"p2",nombre:"Proveedor Demo 2",tipo:"compra_directa",telefono:"",notas:""}
  ],
  ventas:[],
  apartados:[],
  saldos:[],
  archivo:[],
  config:{accessPass:"JDH1", adminPass:"arcana2024", logo:""}
};

var carrito = [];
var etiqSel = {};
var epbSel = {};

var _uidCounter=0;
// Detector de IDs duplicados (red de seguridad). Devuelve numero de duplicados encontrados.
function detectarDuplicados(auto){
  if(!DB.items) return 0;
  var vistos={}, dups=[];
  for(var i=0;i<DB.items.length;i++){
    var id=DB.items[i].id;
    if(vistos[id]!==undefined) dups.push(DB.items[i]);
    else vistos[id]=i;
  }
  if(dups.length>0){
    // Auto-reparar: asignar ID nuevo a los duplicados
    if(auto){
      for(var d=0;d<dups.length;d++) dups[d].id=uid();
      _itemIndex=null; _provIndex=null;
      dbSave();
      console.log("Arcana: se repararon "+dups.length+" ID(s) duplicado(s) automaticamente.");
    }
  }
  return dups.length;
}
function uid(){
  // Timestamp + contador incremental + aleatorio largo = imposible duplicar
  // incluso creando miles de IDs en el mismo milisegundo (importaciones masivas)
  _uidCounter=(_uidCounter+1)%1000000;
  return Date.now().toString(36)+"-"+_uidCounter.toString(36)+"-"+Math.random().toString(36).slice(2,9);
}
function hoy(){ return new Date().toISOString().slice(0,10); }
// Dia comercial: ventas antes de las 3 AM cuentan como el dia anterior
function diaComercial(fechaHora){
  var d = fechaHora ? new Date(fechaHora) : new Date();
  // Restar 3 horas: si son las 2 AM del martes, se vuelve 11 PM del lunes
  var ajustada = new Date(d.getTime() - 3*3600*1000);
  // Formato YYYY-MM-DD en hora local
  var y=ajustada.getFullYear();
  var m=String(ajustada.getMonth()+1).padStart(2,"0");
  var dd=String(ajustada.getDate()).padStart(2,"0");
  return y+"-"+m+"-"+dd;
}
// Timestamp completo para registrar ventas (para poder recalcular dia comercial)
function ahora(){ return new Date().toISOString(); }
function fmt(n){ return new Intl.NumberFormat("es-MX",{style:"currency",currency:"MXN",maximumFractionDigits:0}).format(n||0); }
function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function ge(id){ return document.getElementById(id); }

function fiscal(p,mpago){
  mpago=mpago||"tarjeta";
  if(mpago==="efectivo"){
    // Efectivo: sin IVA, sin ISR, sin comision de terminal
    return {base:p,iva:0,isr:0,term:0,neto:p};
  }
  if(mpago==="transferencia"){
    // Transferencia: con IVA e ISR, SIN comision de terminal
    var base=p/1.16,iva=p-base,isr=p*0.015;
    return {base:base,iva:iva,isr:isr,term:0,neto:p-iva-isr};
  }
  // Tarjeta: IVA + ISR + comision terminal
  var base=p/1.16,iva=p-base,isr=p*0.015,term=p*0.0406;
  return {base:base,iva:iva,isr:isr,term:term,neto:p-iva-isr-term};
}
function ganancia(item,mpago){ return fiscal(item.precioVenta||0,mpago).neto-(item.costoProveedor||0); }
function costoNeto(it){
  if(!it) return 0;
  var pv=getProv(it.proveedorId);
  if(pv && pv.tipo==="consignacion") return it.costoProveedor||0;
  return 0;
}
// Indices para busqueda instantanea (evita recorrer miles de productos cada vez)
var _itemIndex=null, _provIndex=null;
function rebuildIndex(){
  _itemIndex={}; _provIndex={};
  if(DB.items) for(var i=0;i<DB.items.length;i++) _itemIndex[DB.items[i].id]=DB.items[i];
  if(DB.provs) for(var i=0;i<DB.provs.length;i++) _provIndex[DB.provs[i].id]=DB.provs[i];
}
function getProv(id){
  if(!_provIndex) rebuildIndex();
  var p=_provIndex[id];
  if(p&&p.id===id) return p;
  // fallback por si el indice quedo desactualizado
  for(var i=0;i<DB.provs.length;i++) if(DB.provs[i].id===id){ _provIndex[id]=DB.provs[i]; return DB.provs[i]; }
  return null;
}
function getItem(id){
  if(!_itemIndex) rebuildIndex();
  var it=_itemIndex[id];
  if(it&&it.id===id) return it;
  for(var i=0;i<DB.items.length;i++) if(DB.items[i].id===id){ _itemIndex[id]=DB.items[i]; return DB.items[i]; }
  return null;
}
function getDups(){ var c={}; for(var i=0;i<DB.items.length;i++) c[DB.items[i].sku]=(c[DB.items[i].sku]||0)+1; var d={}; for(var k in c) if(c[k]>1) d[k]=true; return d; }
function OM(tit,html){ ge("mtit").textContent=tit; ge("mbody").innerHTML=html; ge("mbg").classList.add("on"); }
function CM(){ ge("mbg").classList.remove("on"); ge("mbody").innerHTML=""; }

function reqAdmin(name,btn){
  if(TABS_LIBRES[name]){ ST(name,btn); return; }
  if(sessionAdmin){ ST(name,btn); return; }
  // Store pending nav for after password modal
  pendingNav = {name:name, btn:btn};
  var h='<div class="fld">';
  h+='<label class="lbl">Contrasena de administrador</label>';
  h+='<div style="position:relative">';
  h+='<input class="inp" type="password" id="admin-pass-input" placeholder="Escribe la contrasena..." style="padding-right:44px"/>';
  h+='<button onclick="togglePassVis()" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:#6b6358;font-size:16px;cursor:pointer" id="pass-eye">&#128065;</button>';
  h+='</div></div>';
  h+='<div id="pass-error" style="color:#f87171;font-size:12px;min-height:16px;margin-bottom:8px"></div>';
  h+='<div style="display:flex;gap:8px;justify-content:flex-end">';
  h+='<button class="btn" onclick="CM()">Cancelar</button>';
  h+='<button class="btna" onclick="confirmarAdmin()">Entrar</button></div>';
  OM("Acceso administrador", h);
  setTimeout(function(){
    var el=ge("admin-pass-input");
    if(el){
      el.focus();
      el.addEventListener("keydown", function(e){ if(e.key==="Enter") confirmarAdmin(); });
    }
  }, 150);
}

var pendingNav = null;

function togglePassVis(){
  var inp=ge("admin-pass-input"); if(!inp) return;
  var eye=ge("pass-eye");
  if(inp.type==="password"){
    inp.type="text";
    if(eye) eye.innerHTML="&#128683;";
  } else {
    inp.type="password";
    if(eye) eye.innerHTML="&#128065;";
  }
}

function confirmarAdmin(){
  var inp=ge("admin-pass-input"); if(!inp) return;
  var pass=inp.value;
  if(pass===getAdminPass()){
    sessionAdmin=true; CM();
    if(pendingNav){ ST(pendingNav.name, pendingNav.btn); pendingNav=null; }
  } else {
    var err=ge("pass-error");
    if(err) err.textContent="Contrasena incorrecta. Intenta de nuevo.";
    inp.value=""; inp.focus();
  }
}
function cerrarSesionAdmin(){
  sessionAdmin=false;
  var tabs=document.querySelectorAll(".tab"); for(var i=0;i<tabs.length;i++) tabs[i].classList.remove("on");
  var nbs=document.querySelectorAll(".nb"); for(var i=0;i<nbs.length;i++) nbs[i].classList.remove("on");
  ge("tab-pos").classList.add("on"); ge("btn-pos").classList.add("on");
  PH(); RC(); alert("Sesion de administrador cerrada.");
}
function cambiarPass(){
  var eyeBtn = 'style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:#6b6358;font-size:16px;cursor:pointer"';
  var row1 = '<div class="fld"><label class="lbl">Contrasena actual</label><div style="position:relative"><input class="inp" type="password" id="cp-actual" style="padding-right:44px"/><button id="eye-actual" '+eyeBtn+'>&#128065;</button></div></div>';
  var row2 = '<div class="fld"><label class="lbl">Nueva contrasena (minimo 4 caracteres)</label><div style="position:relative"><input class="inp" type="password" id="cp-nueva" style="padding-right:44px"/><button id="eye-nueva" '+eyeBtn+'>&#128065;</button></div></div>';
  var row3 = '<div class="fld"><label class="lbl">Confirmar nueva contrasena</label><div style="position:relative"><input class="inp" type="password" id="cp-conf" style="padding-right:44px"/><button id="eye-conf" '+eyeBtn+'>&#128065;</button></div></div>';
  var footer = '<div id="cp-error" style="color:#f87171;font-size:12px;min-height:16px;margin-bottom:8px"></div><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" onclick="CM()">Cancelar</button><button class="btna" onclick="guardarPass()">Guardar</button></div>';
  OM("Cambiar contrasena", row1+row2+row3+footer);
  setTimeout(function(){
    var pairs = [["eye-actual","cp-actual"],["eye-nueva","cp-nueva"],["eye-conf","cp-conf"]];
    for(var i=0;i<pairs.length;i++){
      (function(eyeId,inpId){
        var btn=ge(eyeId); if(btn) btn.addEventListener("click",function(){ toggleVis(inpId); });
      })(pairs[i][0],pairs[i][1]);
    }
  }, 100);
}

function toggleVis(id){
  var inp=ge(id); if(!inp) return;
  inp.type=inp.type==="password"?"text":"password";
}

function guardarPass(){
  var actual=(ge("cp-actual")||{}).value||"";
  var nueva=(ge("cp-nueva")||{}).value||"";
  var conf=(ge("cp-conf")||{}).value||"";
  var err=ge("cp-error");
  if(actual!==getAdminPass()){ if(err) err.textContent="La contrasena actual es incorrecta."; return; }
  if(nueva.length<4){ if(err) err.textContent="La nueva contrasena debe tener al menos 4 caracteres."; return; }
  if(nueva!==conf){ if(err) err.textContent="Las contrasenas no coinciden."; return; }
  setAdminPass(nueva); CM(); alert("Contrasena de administrador actualizada correctamente.");
}

// ── CONTRASENA DE ACCESO GENERAL (pantalla de bloqueo al abrir el programa) ──
function tryAccessLogin(){
  var inp=ge("acc-pass-input"); if(!inp) return;
  var err=ge("acclock-err");
  if(inp.value===getAccessPass()){
    ge("acclock").style.display="none";
    ge("appwrap").style.display="block";
  } else {
    if(err) err.textContent="Contrasena incorrecta.";
    inp.value=""; inp.focus();
  }
}
function cambiarPassAcceso(){
  var eyeBtn = 'style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:#6b6358;font-size:16px;cursor:pointer"';
  var row1 = '<div class="fld"><label class="lbl">Contrasena de acceso actual</label><div style="position:relative"><input class="inp" type="password" id="cpa-actual" style="padding-right:44px"/><button id="eye-a-actual" '+eyeBtn+'>&#128065;</button></div></div>';
  var row2 = '<div class="fld"><label class="lbl">Nueva contrasena de acceso (minimo 4 caracteres)</label><div style="position:relative"><input class="inp" type="password" id="cpa-nueva" style="padding-right:44px"/><button id="eye-a-nueva" '+eyeBtn+'>&#128065;</button></div></div>';
  var row3 = '<div class="fld"><label class="lbl">Confirmar nueva contrasena</label><div style="position:relative"><input class="inp" type="password" id="cpa-conf" style="padding-right:44px"/><button id="eye-a-conf" '+eyeBtn+'>&#128065;</button></div></div>';
  var footer = '<div id="cpa-error" style="color:#f87171;font-size:12px;min-height:16px;margin-bottom:8px"></div><div class="sm mut" style="margin-bottom:8px">Esta es la contrasena que se pide cada vez que se abre el programa (distinta de la contrasena de administrador).</div><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" onclick="CM()">Cancelar</button><button class="btna" onclick="guardarPassAcceso()">Guardar</button></div>';
  OM("Cambiar contrasena de acceso", row1+row2+row3+footer);
  setTimeout(function(){
    var pairs = [["eye-a-actual","cpa-actual"],["eye-a-nueva","cpa-nueva"],["eye-a-conf","cpa-conf"]];
    for(var i=0;i<pairs.length;i++){
      (function(eyeId,inpId){
        var btn=ge(eyeId); if(btn) btn.addEventListener("click",function(){ toggleVis(inpId); });
      })(pairs[i][0],pairs[i][1]);
    }
  }, 100);
}
function guardarPassAcceso(){
  var actual=(ge("cpa-actual")||{}).value||"";
  var nueva=(ge("cpa-nueva")||{}).value||"";
  var conf=(ge("cpa-conf")||{}).value||"";
  var err=ge("cpa-error");
  if(actual!==getAccessPass()){ if(err) err.textContent="La contrasena actual es incorrecta."; return; }
  if(nueva.length<4){ if(err) err.textContent="La nueva contrasena debe tener al menos 4 caracteres."; return; }
  if(nueva!==conf){ if(err) err.textContent="Las contrasenas no coinciden."; return; }
  setAccessPass(nueva); CM(); alert("Contrasena de acceso actualizada correctamente.");
}

function ST(name,btn){
  var tabs=document.querySelectorAll(".tab"); for(var i=0;i<tabs.length;i++) tabs[i].classList.remove("on");
  var nbs=document.querySelectorAll(".nb"); for(var i=0;i<nbs.length;i++) nbs[i].classList.remove("on");
  var mnbs=document.querySelectorAll(".mnb"); for(var i=0;i<mnbs.length;i++) mnbs[i].classList.remove("on");
  ge("tab-"+name).classList.add("on"); btn.classList.add("on");
  // Sync mobile nav
  var mobBtn=ge("mbn-"+name); if(mobBtn) mobBtn.classList.add("on");
  // Sync desktop nav
  var deskMap={"pos":"btn-pos","etiq-pub":"btn-etiq-pub","inventario":"btn-inv","proveedores":"btn-prov","reportes":"btn-rep","apartados":"btn-apa"};
  if(deskMap[name]){ var db=ge(deskMap[name]); if(db) db.classList.add("on"); }
  if(name==="inventario") RI();
  if(name==="pos"){ PH(); RC(); }
  if(name==="proveedores") RP();
  if(name==="reportes") RR();
  if(name==="etiq-pub") EPB();
  if(name==="apartados") RApa();
}

function initF(){
  var fc=ge("ifc"),fe=ge("ife"),fp=ge("ifp"); if(!fc||!fe||!fp) return;
  var vc=fc.value,ve=fe.value,vp=fp.value;
  var ftl=ge("iftl");
  if(ftl){
    var vtl=ftl.value, ht='<option value="">Todas las tallas</option>';
    for(var i=0;i<TALLAS.length;i++) ht+='<option value="'+esc(TALLAS[i])+'"'+(vtl===TALLAS[i]?" selected":"")+'>'+esc(TALLAS[i])+'</option>';
    ftl.innerHTML=ht;
  }
  var h='<option value="">Todas las categorias</option>';
  for(var i=0;i<CATS.length;i++) h+='<option value="'+esc(CATS[i])+'"'+(vc===CATS[i]?" selected":"")+'>'+esc(CATS[i])+'</option>';
  fc.innerHTML=h;
  h='<option value="">Todas las epocas</option>';
  for(var i=0;i<EPOCAS.length;i++) h+='<option value="'+esc(EPOCAS[i])+'"'+(ve===EPOCAS[i]?" selected":"")+'>'+esc(EPOCAS[i])+'</option>';
  fe.innerHTML=h;
  h='<option value="">Todos los proveedores</option>';
  for(var i=0;i<DB.provs.length;i++) h+='<option value="'+DB.provs[i].id+'"'+(vp===DB.provs[i].id?" selected":"")+'>'+esc(DB.provs[i].nombre)+'</option>';
  fp.innerHTML=h;
}

function RI(){
  var fp=ge("ifp"); if(fp&&fp.options.length-1!==DB.provs.length) initF();
  var fc2=ge("ifc"); if(fc2&&fc2.options.length-1!==CATS.length) initF();
  var ftl2=ge("iftl"); if(ftl2&&ftl2.options.length-1!==TALLAS.length) initF();
  var dups=getDups(),da=ge("da"),dw=ge("dw"),keys=Object.keys(dups);
  if(keys.length){ da.style.display="block"; da.textContent=keys.length+" clave"+(keys.length>1?"s":"")+" duplicada"+(keys.length>1?"s":""); dw.style.display="block"; dw.textContent="Claves duplicadas: "+keys.join(", "); }
  else{ da.style.display="none"; dw.style.display="none"; }
  var q=(ge("ib").value||"").toLowerCase();
  var fc=ge("ifc").value, fe=ge("ife").value, fpv=ge("ifp").value, fs=ge("ifstock").value;
  var ftlEl=ge("iftl"), ftl=ftlEl?ftlEl.value:"";
  var list=[];
  for(var i=0;i<DB.items.length;i++){
    var it=DB.items[i];
    var mq=!q; if(!mq){ var ff=[it.sku,it.descripcion,it.notas,it.categoria,it.epoca,it.talla]; for(var j=0;j<ff.length;j++) if(String(ff[j]||"").toLowerCase().indexOf(q)!==-1){mq=true;break;} }
    var ms=!fs||(fs==="disponibles"&&(it.cantidad||0)>0)||(fs==="vendidos"&&(it.cantidad||0)===0);
    var mcat=!fc||String(it.categoria||"").trim().toLowerCase()===String(fc).trim().toLowerCase();
    var mep=!fe||String(it.epoca||"").trim().toLowerCase()===String(fe).trim().toLowerCase();
    var mtl=!ftl||String(it.talla||"")===ftl;
    if(mq&&mcat&&mep&&mtl&&(!fpv||it.proveedorId===fpv)&&ms) list.push(it);
  }
  var pz=0; for(var i=0;i<list.length;i++) pz+=list[i].cantidad||0;
  ge("ic").textContent=list.length+" de "+DB.items.length+" conceptos - "+pz+" piezas";
  var tb=ge("itb");
  if(!list.length){ tb.innerHTML='<tr><td colspan="13" style="padding:36px;text-align:center;color:#4a4540">Sin resultados</td></tr>'; return; }
  var h="";
  for(var i=0;i<list.length;i++){
    var it=list[i], pv=getProv(it.proveedorId), g=ganancia(it), dup=dups[it.sku]?true:false;
    h+='<tr>';
    h+='<td style="width:36px;text-align:center"><input type="checkbox" class="item-chk" data-id="'+it.id+'" style="cursor:pointer;width:15px;height:15px;accent-color:#c9a96e" onchange="updSel()"/></td>';
    h+='<td><span class="mono" style="color:'+(dup?"#f87171":"#c9a96e")+';font-size:12px">'+esc(it.sku)+'</span>'+(dup?' <span style="color:#f87171">!</span>':'')+' </td>';
    h+='<td style="max-width:220px"><div style="font-weight:500;line-height:1.3">'+esc(it.descripcion||"")+'</div>'+(it.notas?'<div class="sm mut it">'+esc(it.notas)+'</div>':'')+' </td>';
    h+='<td class="mut sm">'+esc(it.categoria||"")+'</td>';
    h+='<td class="mut sm">'+esc(it.epoca||"")+'</td>';
    h+='<td class="mut sm" style="text-align:center">'+esc(it.talla||"")+'</td>';
    h+='<td style="text-align:center"><span class="pill '+((it.cantidad||0)>0?"pg":"pr")+'">'+(it.cantidad||0)+'</span></td>';
    h+='<td><div style="font-size:12px">'+esc(pv?pv.nombre:"")+'</div><div class="sm" style="color:'+(pv&&pv.tipo==="consignacion"?"#f59e0b":"#6b6358")+'">'+(pv?(pv.tipo==="consignacion"?"Consig.":"Directa"):"")+' </div></td>';
    h+='<td class="mut sm">'+fmt(it.costoProveedor)+'</td>';
    h+='<td class="'+(g>=0?"gp":"gn")+' sm">'+fmt(g)+'</td>';
    h+='<td class="gold">'+fmt(it.precioVenta)+'</td>';
    h+='<td class="mut sm">'+(it.fechaIngreso||"")+'</td>';
    h+='<td style="white-space:nowrap"><button class="btn btns" onclick="aDet(\''+it.id+'\')">Ver</button> <button class="btn btns" onclick="aItem(\''+it.id+'\')">Editar</button> <button class="btn btns" onclick="eFromInv(\''+it.id+'\')">Etiq</button></td>';
    h+='</tr>';
  }
  tb.innerHTML=h;
  // Render mobile cards
  renderMobCards(list);
}

function renderMobCards(list){
  var el=ge("inv-cards"); if(!el) return;
  el.innerHTML="";
  if(!list||!list.length) return;
  var dups=getDups();
  for(var i=0;i<list.length;i++){
    var it=list[i];
    var pv=getProv(it.proveedorId);
    var g=ganancia(it);
    var dup=dups[it.sku];
    var card=document.createElement("div");
    card.className="mob-card";
    var topDiv=document.createElement("div");
    topDiv.style.cssText="display:flex;justify-content:space-between;align-items:start;margin-bottom:6px";
    var skuDiv=document.createElement("div");
    var skuSpan=document.createElement("div");
    skuSpan.className="mob-card-sku";
    if(dup){var ex=document.createElement("span");ex.style.color="#f87171";ex.textContent="! ";skuSpan.appendChild(ex);}
    skuSpan.appendChild(document.createTextNode(it.sku||""));
    var descDiv=document.createElement("div");
    descDiv.className="mob-card-desc";
    descDiv.textContent=it.descripcion||"";
    skuDiv.appendChild(skuSpan);
    skuDiv.appendChild(descDiv);
    if(pv){var pvDiv=document.createElement("div");pvDiv.className="sm mut";pvDiv.textContent=pv.nombre;skuDiv.appendChild(pvDiv);}
    var badge=document.createElement("span");
    badge.className="pill "+(((it.cantidad||0)>0)?"pg":"pr");
    badge.style.marginLeft="8px";
    badge.textContent=String(it.cantidad||0);
    topDiv.appendChild(skuDiv);
    topDiv.appendChild(badge);
    card.appendChild(topDiv);
    var statsDiv=document.createElement("div");
    statsDiv.style.cssText="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px";
    function mkStat(label,val,cls){
      var d=document.createElement("div");
      var l=document.createElement("div");l.className="mob-card-label";l.textContent=label;
      var v=document.createElement("div");if(cls)v.className=cls;v.textContent=val;
      d.appendChild(l);d.appendChild(v);return d;
    }
    statsDiv.appendChild(mkStat("Precio",fmt(it.precioVenta),"gold"));
    statsDiv.appendChild(mkStat("Costo",fmt(it.costoProveedor),"mut sm"));
    statsDiv.appendChild(mkStat("Ganancia",fmt(g),g>=0?"gp sm":"gn sm"));
    card.appendChild(statsDiv);
    var btnRow=document.createElement("div");
    btnRow.style.cssText="display:flex;gap:6px";
    var btnVer=document.createElement("button");
    btnVer.className="btn btns";btnVer.style.flex="1";btnVer.textContent="Ver";
    var btnEdit=document.createElement("button");
    btnEdit.className="btna btns";btnEdit.style.flex="1";btnEdit.textContent="Editar";
    (function(id){
      btnVer.addEventListener("click",function(){aDet(id);});
      btnEdit.addEventListener("click",function(){aItem(id);});
    })(it.id);
    btnRow.appendChild(btnVer);btnRow.appendChild(btnEdit);
    card.appendChild(btnRow);
    el.appendChild(card);
  }
}

function updSel(){
  var chks=document.querySelectorAll(".item-chk"), count=0;
  for(var i=0;i<chks.length;i++) if(chks[i].checked) count++;
  var btn=ge("btn-del-sel"); if(btn){ btn.style.display=count>0?"block":"none"; if(count>0) btn.textContent="Eliminar "+count+" seleccionada"+(count>1?"s":""); }
  var all=ge("chk-all"); if(all) all.checked=count>0&&count===chks.length;
}
function delSel(){
  var chks=document.querySelectorAll(".item-chk"),ids=[];
  for(var i=0;i<chks.length;i++) if(chks[i].checked) ids.push(chks[i].getAttribute("data-id"));
  if(!ids.length) return;
  if(!confirm("Eliminar "+ids.length+" prenda"+(ids.length>1?"s":"")+"?")) return;
  var idSet={}; for(var i=0;i<ids.length;i++) idSet[ids[i]]=true;
  DB.items=DB.items.filter(function(it){ return !idSet[it.id]; });
  dbSave(); RI(); var btn=ge("btn-del-sel"); if(btn) btn.style.display="none";
}

function aItem(id){
  var it=id?getItem(id):null;
  var co='<option value="">-</option>'; for(var i=0;i<CATS.length;i++) co+='<option'+(it&&it.categoria===CATS[i]?" selected":"")+'>'+esc(CATS[i])+'</option>';
  var eo='<option value="">-</option>'; for(var i=0;i<EPOCAS.length;i++) eo+='<option'+(it&&it.epoca===EPOCAS[i]?" selected":"")+'>'+esc(EPOCAS[i])+'</option>';
  var po='<option value="">-- Selecciona un proveedor --</option>'; for(var i=0;i<DB.provs.length;i++) po+='<option value="'+DB.provs[i].id+'"'+(it&&it.proveedorId===DB.provs[i].id?" selected":"")+'>'+esc(DB.provs[i].nombre)+'</option>';
  var h='<div class="g2"><div class="fld"><label class="lbl" id="slbl">Clave/SKU</label><input class="inp" id="fsk" value="'+esc(it?it.sku:"")+'"/></div>';
  h+='<div class="fld"><label class="lbl">Cantidad</label><input class="inp" type="number" min="0" id="fca" value="'+(it?it.cantidad:1)+'"/></div></div>';
  h+='<div class="fld"><label class="lbl">Descripcion</label><textarea class="inp" id="fde" rows="2">'+esc(it?it.descripcion:"")+'</textarea></div>';
  var to='<option value="">-</option>'; for(var i=0;i<TALLAS.length;i++) to+='<option'+(it&&it.talla===TALLAS[i]?" selected":"")+'>'+esc(TALLAS[i])+'</option>';
  h+='<div class="g2"><div class="fld"><label class="lbl">Categoria</label><select class="inp" id="fct">'+co+'</select></div>';
  h+='<div class="fld"><label class="lbl">Epoca</label><select class="inp" id="fep">'+eo+'</select></div></div>';
  h+='<div class="fld"><label class="lbl">Talla</label><select class="inp" id="ftl">'+to+'</select></div>';
  h+='<div class="fld"><label class="lbl">Proveedor</label><select class="inp" id="fpr">'+po+'</select></div>';
  h+='<div class="g2"><div class="fld"><label class="lbl">Costo proveedor</label><input class="inp" type="number" id="fco" value="'+(it?it.costoProveedor:"")+'"/></div>';
  h+='<div class="fld"><label class="lbl">Precio de venta (IVA incluido)</label><input class="inp" type="number" id="fpr2" value="'+(it?it.precioVenta:"")+'"/></div></div>';
  h+='<div id="fprev" class="fb" style="display:none"></div>';
  h+='<div class="fld"><label class="lbl">Fecha de ingreso</label><input class="inp" type="date" id="ffi" value="'+(it?it.fechaIngreso:hoy())+'"/></div>';
  h+='<div class="fld"><label class="lbl">Notas</label><textarea class="inp" id="fno" rows="2">'+esc(it?it.notas:"")+'</textarea></div>';
  h+='<div style="display:flex;justify-content:space-between;padding-top:7px">'+(it?'<button class="btnr" onclick="delItem(\''+id+'\')">Eliminar</button>':'<div></div>');
  h+='<button class="btna" onclick="saveItem(\''+( id||"")+'\')" >Guardar</button></div>';
  OM(it?"Editar prenda":"Nueva prenda",h);
  ge("fco").addEventListener("input",prevF); ge("fpr2").addEventListener("input",prevF); prevF();
}
function prevF(){
  var co=parseFloat(ge("fco").value)||0, pr=parseFloat(ge("fpr2").value)||0, el=ge("fprev"); if(!el) return;
  if(pr<=0&&co<=0){el.style.display="none";return;}
  var f=fiscal(pr), g=f.neto-co, pct=pr>0?Math.round(g/pr*100):0;
  el.style.display="block";
  el.innerHTML='<div class="sm" style="color:#6b6358;text-transform:uppercase;margin-bottom:5px">Desglose de '+fmt(pr)+'</div>'+
    '<div class="fr"><span class="mut sm">Base sin IVA</span><span class="sm">'+fmt(f.base)+'</span></div>'+
    '<div class="fr"><span class="mut sm">IVA 16%</span><span class="sm" style="color:#f87171">-'+fmt(f.iva)+'</span></div>'+
    '<div class="fr"><span class="mut sm">ISR RESICO 1.5%</span><span class="sm" style="color:#f87171">-'+fmt(f.isr)+'</span></div>'+
    '<div class="fr"><span class="mut sm">Terminal 4.06%</span><span class="sm" style="color:#f87171">-'+fmt(f.term)+'</span></div>'+
    '<div class="fr"><span class="mut sm">Costo proveedor</span><span class="sm" style="color:#f87171">-'+fmt(co)+'</span></div>'+
    '<div style="display:flex;justify-content:space-between;padding-top:5px;margin-top:3px;border-top:1px solid #2a2620;font-weight:700"><span>Ganancia real</span><span style="color:'+(g>=0?"#4ade80":"#f87171")+'">'+fmt(g)+' ('+pct+'%)</span></div>';
}
function saveItem(id){
  var sku=ge("fsk").value.trim(); if(!sku){alert("La clave es obligatoria");return;}
  var provSel=ge("fpr").value;
  if(!provSel){alert("Selecciona un proveedor. Toda pieza debe tener un proveedor asignado.");return;}
  var provIdSel=ge("fpr").value;
  if(!provIdSel){ alert("Selecciona un proveedor. Toda pieza debe tener un proveedor asignado."); return; }
  var isDup=false; for(var i=0;i<DB.items.length;i++) if(DB.items[i].sku===sku&&DB.items[i].id!==id){isDup=true;break;}
  if(isDup&&!confirm("Clave duplicada. Continuar?")) return;
  var cant=parseInt(ge("fca").value)||0;
  var d={sku:sku,cantidad:cant,descripcion:ge("fde").value,categoria:ge("fct").value,epoca:ge("fep").value,talla:ge("ftl")?ge("ftl").value:"",proveedorId:ge("fpr").value,costoProveedor:parseFloat(ge("fco").value)||0,precioVenta:parseFloat(ge("fpr2").value)||0,fechaIngreso:ge("ffi").value||hoy(),notas:ge("fno").value};
  if(id){ for(var i=0;i<DB.items.length;i++) if(DB.items[i].id===id){ DB.items[i]=Object.assign({},DB.items[i],d); break; } }
  else{ d.id=uid(); d.cantidadInicial=cant; DB.items.unshift(d); }
  dbSave(); CM(); RI();
}
function delItem(id){ if(!confirm("Eliminar esta prenda?")) return; DB.items=DB.items.filter(function(i){ return i.id!==id; }); dbSave(); CM(); RI(); }
function aDet(id){
  var it=getItem(id); if(!it) return;
  var pv=getProv(it.proveedorId), f=fiscal(it.precioVenta||0), g=f.neto-(it.costoProveedor||0);
  var rows=[["Clave",it.sku],["Categoria",it.categoria||""],["Epoca",it.epoca||""],["Cantidad",it.cantidad],["Proveedor",pv?pv.nombre:""],["Tipo",pv?(pv.tipo==="consignacion"?"Consignacion":"Compra directa"):""],["Fecha ingreso",it.fechaIngreso||""]];
  var h='<p class="mut it" style="font-size:14px;margin-bottom:14px">'+esc(it.descripcion)+'</p><div class="g2" style="gap:7px 18px;margin-bottom:13px">';
  for(var i=0;i<rows.length;i++) h+='<div style="border-bottom:1px solid #1e1c18;padding-bottom:4px"><div class="lbl">'+rows[i][0]+'</div><div style="font-size:13px">'+rows[i][1]+'</div></div>';
  h+='</div><div class="fb"><div class="sm" style="color:#6b6358;text-transform:uppercase;margin-bottom:5px">Desglose de '+fmt(it.precioVenta)+'</div>'+
    '<div class="fr"><span class="mut sm">IVA 16%</span><span class="sm" style="color:#f87171">-'+fmt(f.iva)+'</span></div>'+
    '<div class="fr"><span class="mut sm">ISR RESICO 1.5%</span><span class="sm" style="color:#f87171">-'+fmt(f.isr)+'</span></div>'+
    '<div class="fr"><span class="mut sm">Terminal 4.06%</span><span class="sm" style="color:#f87171">-'+fmt(f.term)+'</span></div>'+
    '<div class="fr"><span class="mut sm">Costo proveedor</span><span class="sm" style="color:#f87171">-'+fmt(it.costoProveedor)+'</span></div>'+
    '<div style="display:flex;justify-content:space-between;padding-top:5px;margin-top:3px;border-top:1px solid #2a2620;font-weight:700"><span>Ganancia real</span><span style="color:'+(g>=0?"#4ade80":"#f87171")+'">'+fmt(g)+'</span></div></div>';
  if(it.notas) h+='<div style="margin-top:11px;padding:9px;background:#0f0e0c;border-radius:8px;border-left:3px solid #2a2620"><div class="lbl">Notas</div><div class="sm mut it">'+esc(it.notas)+'</div></div>';
  OM(it.sku,h);
}

// ── POS ───────────────────────────────────────────────────────────────────────
function PR(){
  var q=(ge("pb").value||"").toLowerCase(), el=ge("pres"); if(!q){el.style.display="none";return;}
  var res=[]; for(var i=0;i<DB.items.length&&res.length<8;i++){ var it=DB.items[i]; if((it.cantidad||0)>0){ var ff=[it.sku,it.descripcion,it.categoria,it.talla]; for(var j=0;j<ff.length;j++) if(String(ff[j]||"").toLowerCase().indexOf(q)!==-1){res.push(it);break;} } }
  if(!res.length){el.style.display="none";return;}
  el.style.display="block";
  var h=""; for(var i=0;i<res.length;i++){
    var it=res[i],pv=getProv(it.proveedorId);
    h+='<div onclick="PA(\''+it.id+'\')" style="display:flex;justify-content:space-between;align-items:center;padding:9px 15px;border-bottom:1px solid #1e1c18;cursor:pointer" onmouseover="this.style.background=\'#1e1c18\'" onmouseout="this.style.background=\'\'">';
    h+='<div><span class="mono gold sm" style="margin-right:9px">'+esc(it.sku)+'</span><span style="font-size:13px">'+esc(it.descripcion)+'</span>'+(it.talla?'<span class="sm" style="margin-left:7px;color:#c9a96e;font-weight:600">'+esc(it.talla)+'</span>':'')+'<span class="sm mut" style="margin-left:7px">'+esc(pv?pv.nombre:"")+'</span></div>';
    h+='<div style="display:flex;gap:9px;align-items:center"><span class="sm mut">Disp:'+it.cantidad+'</span><span class="gold">'+fmt(it.precioVenta)+'</span></div></div>';
  }
  el.innerHTML=h;
}
function PA(id){
  var it=getItem(id); if(!it) return;
  var found=false; for(var i=0;i<carrito.length;i++) if(carrito[i].id===id){if(carrito[i].cant<it.cantidad)carrito[i].cant++;found=true;break;}
  if(!found) carrito.push({id:id,item:it,cant:1,precio:it.precioVenta||0});
  ge("pb").value=""; ge("pres").style.display="none"; RC();
}
function RC(){
  var el=ge("ci"),tot=ge("ct");
  if(!carrito.length){el.innerHTML='<div style="color:#4a4540;font-size:13px;text-align:center;padding:18px 0">Busca y agrega prendas</div>';tot.style.display="none";return;}
  var h=""; for(var i=0;i<carrito.length;i++){
    var l=carrito[i];
    h+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:9px;padding-bottom:9px;border-bottom:1px solid #1e1c18">';
    h+='<div style="flex:1;min-width:0"><div class="mono gold sm">'+esc(l.item.sku)+'</div><div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(l.item.descripcion)+'</div></div>';
    h+='<button onclick="CC('+i+',-1)" style="background:#1e1c18;border:1px solid #2a2620;border-radius:4px;color:#f0ebe3;width:21px;height:21px;font-size:14px;line-height:1;cursor:pointer">-</button>';
    h+='<span style="font-size:13px;min-width:17px;text-align:center">'+l.cant+'</span>';
    h+='<button onclick="CC('+i+',1)" style="background:#1e1c18;border:1px solid #2a2620;border-radius:4px;color:#f0ebe3;width:21px;height:21px;font-size:14px;line-height:1;cursor:pointer">+</button>';
    h+='<input type="number" value="'+l.precio+'" onchange="CP('+i+',this.value)" style="background:#0f0e0c;border:1px solid #2a2620;border-radius:6px;color:#c9a96e;font-size:12px;padding:3px 5px;width:70px;text-align:right;font-family:inherit"/>';
    h+='<button onclick="CE('+i+')" style="background:none;border:none;color:#6b6358;font-size:16px;padding:2px;cursor:pointer">x</button></div>';
  }
  el.innerHTML=h; tot.style.display="block"; calcC();
}
function CC(i,d){ var l=carrito[i]; if(!l) return; var n=l.cant+d; if(n<1||n>l.item.cantidad) return; l.cant=n; RC(); }
function CP(i,v){ if(carrito[i]) carrito[i].precio=parseFloat(v)||0; calcC(); }
function CE(i){ carrito.splice(i,1); RC(); }
function calcC(){
  var sub=0; for(var i=0;i<carrito.length;i++) sub+=carrito[i].precio*carrito[i].cant;
  var descTipo=(ge("cdesc-tipo")||{}).value||"monto";
  var descVal=parseFloat((ge("cdesc")||{}).value)||0;
  if(descVal<0) descVal=0;
  var desc;
  if(descTipo==="pct"){
    if(descVal>100) descVal=100;
    desc=sub*(descVal/100);
  } else {
    if(descVal>sub) descVal=sub;
    desc=descVal;
  }
  var tot=Math.max(0,sub-desc);
  var es=ge("csub"); if(es) es.textContent=fmt(sub);
  var et=ge("ctot"); if(et) et.textContent=fmt(tot);
  var ed=ge("cdesc-monto");
  if(ed){
    if(desc>0){ ed.style.display="flex"; ed.innerHTML='<span class="sm mut">Descuento aplicado</span><span class="sm" style="color:#f87171">-'+fmt(desc)+(descTipo==="pct"?" ("+descVal+"%)":"")+'</span>'; }
    else ed.style.display="none";
  }
}
function cobrar(){
  if(!carrito.length) return;
  // VALIDACION FINAL DE EXISTENCIA: confirmar que aun hay suficiente inventario real
  // justo antes de registrar la venta. El carrito pudo haberse armado hace rato o en
  // otro dispositivo, y la existencia pudo cambiar mientras tanto. Sin esta verificacion
  // se podria vender mas piezas de las que realmente existen.
  for(var i=0;i<carrito.length;i++){
    var itChk=getItem(carrito[i].id);
    if(!itChk || (itChk.cantidad||0)<carrito[i].cant){
      alert("Ya no hay existencia suficiente de \""+(itChk?itChk.sku:carrito[i].id)+"\". Disponible: "+(itChk?(itChk.cantidad||0):0)+". Ajusta el carrito antes de cobrar.");
      return;
    }
  }
  var lineas=[]; for(var i=0;i<carrito.length;i++){
    var itC=carrito[i].item||getItem(carrito[i].id);
    lineas.push({itemId:carrito[i].id,cantidad:carrito[i].cant,precio:carrito[i].precio,
      proveedorId:itC?itC.proveedorId:null, costoProveedor:itC?(itC.costoProveedor||0):0});
  }
  var mpago=(ge("mpago")||{}).value||"efectivo";
  var descVal2=parseFloat((ge("cdesc")||{}).value)||0;
  var descTipo2=(ge("cdesc-tipo")||{}).value||"monto";
  if(descVal2<0) descVal2=0;
  var sub2=0; for(var i=0;i<lineas.length;i++) sub2+=lineas[i].precio*lineas[i].cantidad;
  var descMonto;
  if(descTipo2==="pct"){ if(descVal2>100) descVal2=100; descMonto=sub2*(descVal2/100); }
  else { if(descVal2>sub2) descVal2=sub2; descMonto=descVal2; }
  RV(lineas,mpago,descMonto); carrito=[];
  if(ge("cdesc")) ge("cdesc").value="0";
  if(ge("cdesc-tipo")) ge("cdesc-tipo").value="monto";
  RC(); PH();
  var s=ge("pok"); s.style.display="block"; setTimeout(function(){ s.style.display="none"; },2500);
}
function PH(){
  var tb=ge("ph");
  var pagoColor={"efectivo":"#4ade80","tarjeta":"#818cf8","transferencia":"#f59e0b"};
  var pagoLabel={"efectivo":"Efectivo","tarjeta":"Tarjeta","transferencia":"Transferencia"};
  var diaHoy=diaComercial();
  // Solo ventas del dia comercial en curso, sin limite
  var ventasHoy=DB.ventas.filter(function(v){ return v.fecha===diaHoy; });
  if(!ventasHoy.length){tb.innerHTML='<tr><td colspan="4" style="padding:18px;text-align:center;color:#4a4540">Sin ventas hoy</td></tr>';RCorte();revisarAlertaApa();return;}
  var h="";
  for(var i=0;i<ventasHoy.length;i++){
    var v=ventasHoy[i], mp=v.mpago||"efectivo";
    var rowBg=v.cancelacion?"#1a0a0a":(i%2?"#0d0c0a":"");
    var apaTag=v.esApartado?' <span class="pill" style="background:#f59e0b22;color:#f59e0b;font-size:9px">APARTADO</span>':'';
    var totalDisplay=v.cancelacion?'<span style="color:#f87171;font-size:11px">DEVOLUCION '+fmt(Math.abs(v.total))+'</span>':'<span class="gold">'+fmt(v.total)+'</span>'+apaTag;
    var detalle="";
    for(var j=0;j<v.lineas.length;j++){
      var l=v.lineas[j], it=getItem(l.itemId);
      var sku=it?it.sku:(l.itemId||"?");
      var desc=it?it.descripcion:"(eliminada)";
      var cancelBtn=l.cancelada?'<span style="color:#f87171;font-size:10px;margin-left:6px">CANCELADA</span>':
        (v.cancelacion?'':'<button onclick="cancelarVenta(\''+v.id+'\','+j+')" style="background:none;border:1px solid #f8717144;border-radius:4px;color:#f87171;font-size:10px;padding:1px 6px;cursor:pointer;margin-left:6px">Cancelar</button>');
      detalle+='<div style="font-size:11px;line-height:1.8;display:flex;align-items:center;flex-wrap:wrap">';
      detalle+='<span class="mono" style="color:'+(l.cancelada?"#6b6358":"#c9a96e")+';margin-right:6px;text-decoration:'+(l.cancelada?"line-through":"none")+'">'+esc(sku)+'</span>';
      detalle+='<span class="mut" style="text-decoration:'+(l.cancelada?"line-through":"none")+'">'+esc(desc)+'</span>';
      if(l.cantidad>1) detalle+='<span style="color:#6b6358;margin:0 4px">x'+l.cantidad+'</span>';
      detalle+='<span style="color:'+(l.cancelada?"#6b6358":"#4ade80")+';margin-left:4px">'+fmt(l.precio*l.cantidad)+'</span>';
      detalle+=cancelBtn+'</div>';
    }
    h+='<tr style="background:'+rowBg+';vertical-align:top"><td class="mut" style="white-space:nowrap">'+v.fecha+'</td>';
    h+='<td><span style="color:'+(pagoColor[mp]||"#a09480")+';font-size:12px">'+(pagoLabel[mp]||mp)+'</span></td>';
    h+='<td style="white-space:nowrap">'+totalDisplay+'</td><td>'+detalle+'</td></tr>';
  }
  tb.innerHTML=h;
  RCorte();
  revisarAlertaApa();
}
function RV(lineas,mpago,descuento){
  var total=0; for(var i=0;i<lineas.length;i++) total+=lineas[i].precio*lineas[i].cantidad;
  total=Math.max(0,total-(descuento||0));
  DB.ventas.unshift({id:uid(),fecha:diaComercial(),ts:ahora(),lineas:lineas,total:total,mpago:mpago||"efectivo",descuento:descuento||0});
  for(var i=0;i<DB.items.length;i++) for(var j=0;j<lineas.length;j++) if(DB.items[i].id===lineas[j].itemId) DB.items[i].cantidad=Math.max(0,(DB.items[i].cantidad||0)-lineas[j].cantidad);
  dbSave();
}
function cancelarVenta(vid,lidx){
  var v=null; for(var i=0;i<DB.ventas.length;i++) if(DB.ventas[i].id===vid){v=DB.ventas[i];break;}
  if(!v) return;
  var linea=v.lineas[lidx]; if(!linea) return;
  var it=getItem(linea.itemId);
  var desc=it?it.sku+" - "+it.descripcion:"pieza eliminada";

  // Calcular el precio REALMENTE pagado por esta linea, prorrateando el descuento
  // global de la venta segun el peso de esta linea en el subtotal (evita devolver
  // de mas cuando la venta tuvo descuento).
  var subtotalVenta=0;
  for(var k=0;k<v.lineas.length;k++) subtotalVenta+=v.lineas[k].precio*v.lineas[k].cantidad;
  var subtotalLinea=linea.precio*linea.cantidad;
  var descuentoVenta=v.descuento||0;
  var montoADevolver=subtotalLinea;
  if(descuentoVenta>0 && subtotalVenta>0){
    var proporcion=subtotalLinea/subtotalVenta;
    montoADevolver=subtotalLinea-(descuentoVenta*proporcion);
  }
  montoADevolver=Math.max(0,Math.round(montoADevolver*100)/100);

  var msg="Cancelar venta de: "+desc+"? La pieza regresara al inventario.";
  if(descuentoVenta>0) msg+="\n\nEsta venta tuvo descuento. Se devolvera el monto real pagado por esta pieza: "+fmt(montoADevolver)+" (no el precio de lista "+fmt(subtotalLinea)+").";
  if(!confirm(msg)) return;
  DB.ventas.unshift({id:uid(),fecha:diaComercial(),ts:ahora(),lineas:[{itemId:linea.itemId,cantidad:linea.cantidad,precio:linea.precio}],total:-montoADevolver,mpago:v.mpago||"efectivo",cancelacion:true,refVenta:vid});
  for(var i=0;i<DB.items.length;i++) if(DB.items[i].id===linea.itemId){DB.items[i].cantidad=(DB.items[i].cantidad||0)+linea.cantidad;break;}
  v.lineas[lidx].cancelada=true;
  dbSave(); PH();
  var tr=ge("tab-reportes"); if(tr&&tr.classList.contains("on")) RR();
  var tp=ge("tab-proveedores"); if(tp&&tp.classList.contains("on")) RP();
  alert("Venta cancelada. La pieza regreso al inventario. Se devolvio "+fmt(montoADevolver)+" a caja.");
}

// ── PROVEEDORES ────────────────────────────────────────────────────────────────
function RP(){
  var h=""; for(var i=0;i<DB.provs.length;i++){
    var p=DB.provs[i],enT=0,ingr=0,cost=0;
    for(var j=0;j<DB.items.length;j++) if(DB.items[j].proveedorId===p.id) enT+=DB.items[j].cantidad||0;
    for(var j=0;j<DB.ventas.length;j++){
      var vpj=DB.ventas[j];
      if(vpj.cancelacion) continue;
      for(var k=0;k<vpj.lineas.length;k++){
        var l=vpj.lineas[k],it=getItem(l.itemId);
        if(l.cancelada) continue;
        if(it&&it.proveedorId===p.id){ingr+=l.precio*l.cantidad;cost+=(it.costoProveedor||0)*l.cantidad;}
      }
    }
    h+='<div class="card"><div style="display:flex;justify-content:space-between;margin-bottom:9px">';
    h+='<div><div style="font-weight:700;font-size:15px">'+esc(p.nombre)+'</div>';
    h+='<div class="sm" style="margin-top:2px;color:'+(p.tipo==="consignacion"?"#f59e0b":"#4ade80")+'">'+(p.tipo==="consignacion"?"Consignacion":"Compra directa")+'</div>';
    if(p.telefono) h+='<div class="sm mut" style="margin-top:2px">'+esc(p.telefono)+'</div>';
    if(p.tipo==="consignacion"){
      if(p.fechaContrato) h+='<div class="sm" style="margin-top:3px;color:#4ade80">Contrato firmado — '+p.fechaContrato+'</div>';
      else h+='<div class="sm" style="margin-top:3px;color:#6b6358">Contrato pendiente de firma</div>';
    }
    h+='</div><div style="display:flex;gap:5px;align-items:start">';
    h+='<button class="btn btns" onclick="aProv(\''+p.id+'\')">Editar</button>';
    h+='<button class="btn btns" style="color:#f59e0b" onclick="limpiarCeros(\''+p.id+'\')">Limpiar ceros</button>';
    h+='<button class="btn btns" onclick="delProv(\''+p.id+'\')">X</button></div></div>';
    if(p.cuentaBancaria) h+='<div class="sm mut" style="margin-bottom:6px"><span style="color:#6b6358">Cuenta:</span> '+esc(p.cuentaBancaria)+'</div>';
    if(p.notas) h+='<div class="sm mut it" style="padding-left:7px;border-left:2px solid #2a2620;margin-bottom:9px">'+esc(p.notas)+'</div>';
    h+='<div class="ps"><div><div class="pv">'+enT+'</div><div class="pl">En tienda</div></div><div><div class="pv">'+fmt(ingr)+'</div><div class="pl">Ingresos</div></div><div><div class="pv">'+fmt(cost)+'</div><div class="pl">A pagar</div></div></div>';
    if(p.tipo==="consignacion"){
      h+='<div style="display:flex;gap:6px;margin-top:9px;flex-wrap:wrap">';
      h+='<button class="btno" style="padding:4px 11px;font-size:11px" onclick="generarContrato(\''+p.id+'\')">Imprimir contrato</button>';
      h+='<button class="btno" style="padding:4px 11px;font-size:11px" onclick="reporteProveedor(\''+p.id+'\')">Reporte de inventario (Anexo A)</button>';
      h+='</div>';
    }
    h+='</div>';
  }
  ge("pgrid").innerHTML=h;
}
function aProv(id){
  var p=id?getProv(id):null;
  var h='<div class="fld"><label class="lbl">Nombre (codigo corto)</label><input class="inp" id="pn" value="'+esc(p?p.nombre:"")+'"/></div>';
  h+='<div class="fld"><label class="lbl">Nombre completo (para el contrato)</label><input class="inp" id="pnc" value="'+esc(p?(p.nombreCompleto||""):"")+'" placeholder="Nombre legal completo del proveedor"/></div>';
  h+='<div class="fld"><label class="lbl">Tipo</label><select class="inp" id="pt"><option value="consignacion"'+(p&&p.tipo==="consignacion"?" selected":"")+'>Consignacion</option><option value="compra_directa"'+(p&&p.tipo==="compra_directa"?" selected":"")+'>Compra directa</option></select></div>';
  h+='<div class="fld"><label class="lbl">Telefono</label><input class="inp" id="ptel" value="'+esc(p?p.telefono:"")+'"/></div>';
  h+='<div class="fld"><label class="lbl">Cuenta bancaria</label><input class="inp" id="pcta" value="'+esc(p?(p.cuentaBancaria||""):"")+'" placeholder="CLABE, tarjeta o banco para pagos"/></div>';
  h+='<div class="fld"><label class="lbl">Notas</label><textarea class="inp" id="pno" rows="2">'+esc(p?p.notas:"")+'</textarea></div>';
  h+='<div style="display:flex;justify-content:flex-end;padding-top:7px"><button class="btna" onclick="saveProv(\''+( id||"")+'\')" >Guardar</button></div>';
  OM(p?"Editar proveedor":"Nuevo proveedor",h);
}
function saveProv(id){
  var n=ge("pn").value.trim(); if(!n){alert("El nombre es obligatorio");return;}
  var d={nombre:n,nombreCompleto:ge("pnc")?ge("pnc").value.trim():"",tipo:ge("pt").value,telefono:ge("ptel").value,cuentaBancaria:ge("pcta")?ge("pcta").value.trim():"",notas:ge("pno").value};
  if(id){ for(var i=0;i<DB.provs.length;i++) if(DB.provs[i].id===id){DB.provs[i]=Object.assign({},DB.provs[i],d);break;} }
  else{ d.id=uid(); DB.provs.push(d); }
  dbSave(); CM(); RP(); initF();
}
function delProv(id){ var p=getProv(id); if(!confirm("Eliminar a "+(p?p.nombre:"")+"?")) return; DB.provs=DB.provs.filter(function(x){ return x.id!==id; }); dbSave(); RP(); }
function limpiarCerosTodos(){
  // Elimina las piezas vendidas (cantidad 0) de TODOS los proveedores de una vez,
  // con la misma proteccion de apartados que limpiarCeros individual.
  // Construir set de piezas protegidas (apartados activos, resguardo, abandonados)
  var reservados={};
  for(var i=0;i<(DB.apartados||[]).length;i++){
    var a=DB.apartados[i];
    if(a.estado!=="activo" && a.estado!=="resguardo" && a.estado!=="abandonado") continue;
    var pzs=apaPiezas(a);
    for(var j=0;j<pzs.length;j++) reservados[pzs[j].itemId]=true;
  }
  // Contar cuantas se eliminarian y cuantas quedan protegidas
  var aEliminar=[], protegidas=0;
  for(var i=0;i<DB.items.length;i++){
    var it=DB.items[i];
    if((it.cantidad||0)!==0) continue;
    if(reservados[it.id]){ protegidas++; continue; }
    aEliminar.push(it);
  }
  if(!aEliminar.length){
    alert("No hay piezas vendidas (en cero) para eliminar."+(protegidas>0?"\n\n("+protegidas+" pieza(s) en cero estan protegidas por apartados y no se tocan.)":""));
    return;
  }
  // Agrupar por proveedor para el mensaje
  var porProv={};
  for(var i=0;i<aEliminar.length;i++){
    var pv=getProv(aEliminar[i].proveedorId);
    var nom=pv?pv.nombre:"(sin proveedor)";
    porProv[nom]=(porProv[nom]||0)+1;
  }
  var detalle=""; for(var nom in porProv) detalle+="\n  \u2022 "+nom+": "+porProv[nom]+" pieza(s)";
  var msg="Eliminar "+aEliminar.length+" pieza(s) vendidas (cantidad 0) de TODOS los proveedores?"+detalle;
  if(protegidas>0) msg+="\n\n"+protegidas+" pieza(s) en cero quedan protegidas por apartados activos y NO se eliminaran.";
  if(!confirm(msg)) return;
  var ids={}; for(var i=0;i<aEliminar.length;i++) ids[aEliminar[i].id]=true;
  DB.items=DB.items.filter(function(it){ return !ids[it.id]; });
  dbSave(); RI(); RP();
  var chk=ge("checklist-cierre"); if(chk) RChecklist();
  alert("Eliminadas "+aEliminar.length+" pieza(s) vendidas de "+Object.keys(porProv).length+" proveedor(es)."+(protegidas>0?"\n"+protegidas+" pieza(s) apartadas quedaron protegidas.":""));
}

function limpiarCeros(provId){
  var p=getProv(provId); if(!p) return;
  // PROTECCION: las piezas de apartados ACTIVOS, en RESGUARDO o ABANDONADOS tienen cantidad 0
  // pero NO deben eliminarse. Activos/resguardo: el apartado sigue vigente.
  // Abandonados: la pieza se vendio y no debe volver a venta ni borrarse (queda como registro).
  var reservados={};
  for(var i=0;i<(DB.apartados||[]).length;i++){
    var a=DB.apartados[i];
    if(a.estado!=="activo" && a.estado!=="resguardo" && a.estado!=="abandonado") continue;
    var pzs=apaPiezas(a);
    for(var j=0;j<pzs.length;j++) reservados[pzs[j].itemId]=true;
  }
  var ceros=[], protegidos=0;
  for(var i=0;i<DB.items.length;i++){
    var it=DB.items[i];
    if(it.proveedorId!==provId||(it.cantidad||0)!==0) continue;
    if(reservados[it.id]) protegidos++;
    else ceros.push(it);
  }
  if(!ceros.length){
    alert("No hay piezas en cero para "+p.nombre+"."+(protegidos>0?"\n\n("+protegidos+" pieza(s) en cero estan protegidas por apartados activos y no se tocan.)":""));
    return;
  }
  var msg="Eliminar "+ceros.length+" pieza"+(ceros.length>1?"s":"")+" con cantidad 0 de "+p.nombre+"?";
  if(protegidos>0) msg+="\n\n"+protegidos+" pieza(s) adicionales en cero NO se eliminaran porque estan reservadas en apartados activos.";
  msg+="\n\nTe recomendamos exportar el PDF antes.";
  if(!confirm(msg)) return;
  var ids={}; for(var i=0;i<ceros.length;i++) ids[ceros[i].id]=true;
  DB.items=DB.items.filter(function(it){ return !ids[it.id]; });
  dbSave(); RI(); RP();
  alert("Eliminadas "+ceros.length+" piezas en cero de "+p.nombre+"."+(protegidos>0?"\n"+protegidos+" pieza(s) apartadas quedaron protegidas.":""));
}

// ── REPORTES ───────────────────────────────────────────────────────────────────
function RCorte(){
  var fechaSel=diaComercial();
  var el=ge("corte-body"); if(!el) return;
  // Aggregate sales for the selected day by payment method
  var acc={efectivo:{n:0,monto:0},tarjeta:{n:0,monto:0},transferencia:{n:0,monto:0}};
  var devol={efectivo:0,tarjeta:0,transferencia:0};
  var totalDia=0, piezasDia=0, ventasDia=0, devolDia=0, anticiposDia=0;
  for(var i=0;i<DB.ventas.length;i++){
    var v=DB.ventas[i];
    if(v.fecha!==fechaSel) continue;
    var mp=v.mpago||"efectivo";
    if(!acc[mp]) acc[mp]={n:0,monto:0};
    if(v.cancelacion){
      devol[mp]=(devol[mp]||0)+Math.abs(v.total);
      devolDia+=Math.abs(v.total);
      totalDia+=v.total; // negative
    } else if(v.esApartado){
      // Liquidated layaway: the money was collected via abonos on their own days,
      // NOT counted as cash-in on liquidation day. Count only the piece as sold.
      ventasDia++;
      for(var j=0;j<v.lineas.length;j++) if(!v.lineas[j].cancelada) piezasDia+=v.lineas[j].cantidad;
    } else {
      acc[mp].n++;
      acc[mp].monto+=v.total;
      totalDia+=v.total;
      ventasDia++;
      for(var j=0;j<v.lineas.length;j++) if(!v.lineas[j].cancelada) piezasDia+=v.lineas[j].cantidad;
    }
  }
  // Layaway abonos (anticipos) collected on this day count as real cash-in
  for(var i=0;i<DB.apartados.length;i++){
    var apa=DB.apartados[i];
    if(!apa.abonos) continue;
    for(var j=0;j<apa.abonos.length;j++){
      var ab=apa.abonos[j];
      if(ab.fecha!==fechaSel) continue;
      var mpa=ab.mpago||"efectivo";
      if(!acc[mpa]) acc[mpa]={n:0,monto:0};
      acc[mpa].monto+=ab.monto||0;
      totalDia+=ab.monto||0;
      anticiposDia+=ab.monto||0;
    }
  }
  var pagoLabel={efectivo:"Efectivo",tarjeta:"Tarjeta",transferencia:"Transferencia"};
  var pagoColor={efectivo:"#4ade80",tarjeta:"#818cf8",transferencia:"#f59e0b"};
  var order=["efectivo","tarjeta","transferencia"];
  var h='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px;margin-bottom:14px">';
  for(var i=0;i<order.length;i++){
    var mp=order[i], a=acc[mp]||{n:0,monto:0}, d=devol[mp]||0;
    var neto=a.monto-d;
    h+='<div style="background:#0f0e0c;border:1px solid #2a2620;border-radius:9px;padding:12px">';
    h+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><span style="width:8px;height:8px;border-radius:50%;background:'+pagoColor[mp]+';display:inline-block"></span><span class="kl" style="margin:0">'+pagoLabel[mp]+'</span></div>';
    h+='<div style="font-size:20px;font-weight:700;color:'+pagoColor[mp]+'">'+fmt(neto)+'</div>';
    h+='<div class="sm mut" style="margin-top:3px">'+a.n+' venta'+(a.n===1?"":"s");
    if(d>0) h+=' &middot; <span style="color:#f87171">-'+fmt(d)+' dev.</span>';
    h+='</div></div>';
  }
  h+='</div>';
  // Grand total
  h+='<div style="display:flex;justify-content:space-between;align-items:center;background:#141210;border:1px solid #c9a96e44;border-radius:10px;padding:14px 17px">';
  h+='<div><div class="kl">Total recaudado el dia</div><div class="sm mut">'+ventasDia+' venta'+(ventasDia===1?"":"s")+' &middot; '+piezasDia+' pieza'+(piezasDia===1?"":"s");
  if(anticiposDia>0) h+=' &middot; <span style="color:#f59e0b">incluye '+fmt(anticiposDia)+' en anticipos de apartados</span>';
  if(devolDia>0) h+=' &middot; <span style="color:#f87171">'+fmt(devolDia)+' en devoluciones</span>';
  h+='</div></div>';
  h+='<div style="font-size:26px;font-weight:800;color:#c9a96e">'+fmt(totalDia)+'</div>';
  h+='</div>';
  if(ventasDia===0&&devolDia===0&&anticiposDia===0){
    h='<div style="text-align:center;padding:26px;color:#4a4540">Sin ventas registradas el '+fechaSel+'</div>';
  }
  el.innerHTML=h;
}
function imprimirCorte(){
  var fechaSel=diaComercial();
  var acc={efectivo:{n:0,monto:0},tarjeta:{n:0,monto:0},transferencia:{n:0,monto:0}};
  var devol={efectivo:0,tarjeta:0,transferencia:0};
  var totalDia=0, piezasDia=0, ventasDia=0;
  var detalle=[];
  for(var i=0;i<DB.ventas.length;i++){
    var v=DB.ventas[i];
    if(v.fecha!==fechaSel) continue;
    var mp=v.mpago||"efectivo";
    if(!acc[mp]) acc[mp]={n:0,monto:0};
    if(v.cancelacion){ devol[mp]=(devol[mp]||0)+Math.abs(v.total); totalDia+=v.total; }
    else{
      acc[mp].n++; acc[mp].monto+=v.total; totalDia+=v.total; ventasDia++;
      for(var j=0;j<v.lineas.length;j++) if(!v.lineas[j].cancelada){
        piezasDia+=v.lineas[j].cantidad;
        var itd=getItem(v.lineas[j].itemId);
        detalle.push({sku:itd?itd.sku:"?",desc:itd?itd.descripcion:"",cant:v.lineas[j].cantidad,precio:v.lineas[j].precio*v.lineas[j].cantidad,mp:mp});
      }
    }
  }
  var pagoLabel={efectivo:"Efectivo",tarjeta:"Tarjeta",transferencia:"Transferencia"};
  var order=["efectivo","tarjeta","transferencia"];
  var css='body{font-family:Arial,sans-serif;font-size:13px;color:#111;margin:22px;max-width:520px}h1{font-size:19px;margin-bottom:2px}';
  css+='.sub{color:#666;font-size:12px;margin-bottom:16px}table{width:100%;border-collapse:collapse;margin:10px 0}';
  css+='th{text-align:left;padding:6px 8px;background:#f5f0e8;border:1px solid #ddd;font-size:11px}td{padding:5px 8px;border:1px solid #eee}';
  css+='.tot{font-size:22px;font-weight:800;color:#5a3e10;margin-top:8px}.mp{font-weight:700;margin-top:14px;color:#5a3e10}';
  var doc='<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'+css+'<\/style><\/head><body>';
  doc+='<h1>Corte de caja - Arcana Vintage</h1>';
  doc+='<div class="sub">Fecha: '+fechaSel+' &middot; Generado: '+hoy()+'</div>';
  doc+='<table><thead><tr><th>Metodo de pago</th><th>Ventas</th><th>Devoluciones</th><th>Neto</th></tr></thead><tbody>';
  for(var i=0;i<order.length;i++){
    var mp=order[i], a=acc[mp]||{n:0,monto:0}, d=devol[mp]||0;
    doc+='<tr><td>'+pagoLabel[mp]+'</td><td>'+a.n+'</td><td>'+(d>0?"-$"+Math.round(d):"-")+'</td><td><b>$'+Math.round(a.monto-d)+'</b></td></tr>';
  }
  doc+='</tbody></table>';
  doc+='<div class="tot">Total del dia: $'+Math.round(totalDia)+'</div>';
  doc+='<div class="sub">'+ventasDia+' ventas &middot; '+piezasDia+' piezas</div>';
  if(detalle.length){
    doc+='<div class="mp">Detalle de prendas vendidas</div>';
    doc+='<table><thead><tr><th>Clave</th><th>Descripcion</th><th>Cant.</th><th>Pago</th><th>Total</th></tr></thead><tbody>';
    for(var i=0;i<detalle.length;i++){
      var dd=detalle[i];
      doc+='<tr><td>'+esc(dd.sku)+'</td><td>'+esc(dd.desc)+'</td><td>'+dd.cant+'</td><td>'+pagoLabel[dd.mp]+'</td><td>$'+Math.round(dd.precio)+'</td></tr>';
    }
    doc+='</tbody></table>';
  }
  doc+='<\/body><\/html>';
  var w=window.open("","_blank","width=600,height=700");
  if(!w){alert("Permite ventanas emergentes para imprimir");return;}
  w.document.write(doc); w.document.close();
  w.onload=function(){ setTimeout(function(){ w.print(); },250); };
}
function RR(){
  var pz=0,vInv=0,ingr=0,cost=0;
  var accIva=0,accIsr=0,accTerm=0;
  for(var i=0;i<DB.items.length;i++){pz+=DB.items[i].cantidad||0;vInv+=(DB.items[i].precioVenta||0)*(DB.items[i].cantidad||0);}
  for(var i=0;i<DB.ventas.length;i++){
    var vi=DB.ventas[i];
    var mpv=vi.mpago||"efectivo";
    if(vi.cancelacion){
      ingr+=vi.total; // negative
      var fc=fiscal(Math.abs(vi.total),mpv);
      accIva-=fc.iva; accIsr-=fc.isr; accTerm-=fc.term;
    } else if(vi.esApartado){
      for(var j=0;j<vi.lineas.length;j++){
        var l=vi.lineas[j]; if(l.cancelada) continue;
        var provIdL=l.proveedorId, costoPL=l.costoProveedor;
        if(provIdL===undefined){ var itFb=getItem(l.itemId); provIdL=itFb?itFb.proveedorId:null; costoPL=itFb?(itFb.costoProveedor||0):0; }
        if(provIdL){ var pvL=getProv(provIdL); if(pvL&&pvL.tipo==="consignacion") cost+=(costoPL||0)*l.cantidad; }
      }
    } else {
      ingr+=vi.total;
      var fv=fiscal(vi.total,mpv);
      accIva+=fv.iva; accIsr+=fv.isr; accTerm+=fv.term;
      for(var j=0;j<vi.lineas.length;j++){
        var l=vi.lineas[j]; if(l.cancelada) continue;
        var provIdL2=l.proveedorId, costoPL2=l.costoProveedor;
        if(provIdL2===undefined){ var itFb2=getItem(l.itemId); provIdL2=itFb2?itFb2.proveedorId:null; costoPL2=itFb2?(itFb2.costoProveedor||0):0; }
        if(provIdL2){ var pvL2=getProv(provIdL2); if(pvL2&&pvL2.tipo==="consignacion") cost+=(costoPL2||0)*l.cantidad; }
      }
    }
  }
  // Ingreso por abonos: cada abono recibido cuenta como ingreso (dinero real en caja),
  // de cualquier apartado excepto cancelados (esos van a saldo a favor, no a ingreso).
  for(var i=0;i<DB.apartados.length;i++){
    var apa=DB.apartados[i];
    if(apa.estado==="cancelado") continue;
    if(!apa.abonos) continue;
    for(var j=0;j<apa.abonos.length;j++){
      var ab=apa.abonos[j], mpa=ab.mpago||"efectivo";
      ingr+=ab.monto||0;
      var fa=fiscal(ab.monto||0,mpa);
      accIva+=fa.iva; accIsr+=fa.isr; accTerm+=fa.term;
    }
  }
  // Saldo a favor retenido (expirado sin usar) = ingreso del negocio, sin pasar por proveedor.
  for(var i=0;i<(DB.saldos||[]).length;i++){
    var sa=DB.saldos[i];
    if(sa.usado) continue;
    if(sa.fechaVencimiento && sa.fechaVencimiento<hoy()){
      ingr+=sa.monto||0; // retenido como ingreso
    }
  }
  var f={iva:accIva,isr:accIsr,term:accTerm};
  var gn=ingr-accIva-accIsr-accTerm-cost;
  var kpis=[["Conceptos",DB.items.length+" productos","#c9a96e"],["Piezas disponibles",pz+" piezas","#4ade80"],["Valor inventario",fmt(vInv),"#c9a96e"],["Ventas registradas",DB.ventas.length,"#94a3b8"],["Ingresos totales",fmt(ingr),"#4ade80"],["Costo proveedores",fmt(cost),"#f87171"],["Ganancia neta real",fmt(gn),"#4ade80"]];
  var kh=""; for(var i=0;i<kpis.length;i++) kh+='<div class="kpi"><div class="kl">'+kpis[i][0]+'</div><div class="kv" style="color:'+kpis[i][2]+'">'+kpis[i][1]+'</div></div>';
  ge("kgrid").innerHTML=kh;
  ge("rfiscal").innerHTML='<div class="g3" style="gap:12px"><div><div class="kl">IVA acumulado</div><div style="font-size:17px;font-weight:700;color:#f87171">'+fmt(f.iva)+'</div></div><div><div class="kl">Reserva ISR RESICO 1.5%</div><div style="font-size:17px;font-weight:700;color:#f59e0b">'+fmt(f.isr)+'</div></div><div><div class="kl">Comisiones terminal</div><div style="font-size:17px;font-weight:700;color:#818cf8">'+fmt(f.term)+'</div></div></div><div class="sm mut" style="margin-top:9px">Efectivo sin impuestos ni comision. Transferencia con impuestos sin comision. Tarjeta con todo.</div>';
  var provFiltro=(ge("rprov-filtro")||{}).value||"conventas";
  var ph="",provMostrados=0; 
  for(var i=0;i<DB.provs.length;i++){
    var p=DB.provs[i],enT=0,inP=0,cP=0;
    for(var j=0;j<DB.items.length;j++) if(DB.items[j].proveedorId===p.id) enT+=DB.items[j].cantidad||0;
    for(var j=0;j<DB.ventas.length;j++){
      var vj=DB.ventas[j];
      if(vj.cancelacion) continue;
      for(var k=0;k<vj.lineas.length;k++){
        var l2=vj.lineas[k],it2=getItem(l2.itemId);
        if(l2.cancelada) continue;
        if(it2&&it2.proveedorId===p.id){inP+=l2.precio*l2.cantidad;cP+=(it2.costoProveedor||0)*l2.cantidad;}
      }
    }
    var gp=inP-cP;
    // Filter: only show providers with sales unless "todos"
    if(provFiltro==="conventas" && inP===0) continue;
    provMostrados++;
    ph+='<tr style="background:'+(provMostrados%2?"#0d0c0a":"")+'" ><td style="font-weight:600">'+esc(p.nombre)+'</td><td><span class="sm" style="color:'+(p.tipo==="consignacion"?"#f59e0b":"#4ade80")+'">'+(p.tipo==="consignacion"?"Consig.":"Directa")+'</span></td><td class="mut">'+enT+'</td><td class="gold">'+fmt(inP)+'</td><td style="color:#f87171">'+fmt(cP)+'</td><td class="'+(gp>=0?"gp":"gn")+'">'+fmt(gp)+'</td></tr>';
  }
  ge("rprov").innerHTML=ph||'<tr><td colspan="6" style="padding:20px;text-align:center;color:#4a4540">'+(provFiltro==="conventas"?"Ningun proveedor con ventas aun":"Sin datos")+'</td></tr>';
  RMeses();
  RChecklist();
  RGrafica();
}

// Nombres de meses en espanol
var MESES_ES=["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
function nombreMes(ym){
  var p=ym.split("-"); return MESES_ES[parseInt(p[1])-1]+" "+p[0];
}

// Agrupa las ventas activas por mes (YYYY-MM) y renderiza secciones plegables
function RChecklist(){
  var el=ge("checklist-cierre"); if(!el) return;
  // El checklist sigue el MES ACTUAL en curso (el que se estara cerrando cuando termine).
  // Si el mes actual ya esta cerrado (caso raro) o no tiene ventas, se busca el mes mas
  // reciente con ventas activas que aun no este archivado.
  var hoyStr=diaComercial();
  var ymCerrar=hoyStr.slice(0,7);
  var yaCerradoActual=false;
  for(var i=0;i<DB.archivo.length;i++) if(DB.archivo[i].mes===ymCerrar){ yaCerradoActual=true; break; }
  if(yaCerradoActual){
    // Buscar si hay un mes anterior con ventas activas (aun sin archivar)
    var mesesConVentas={};
    for(var i=0;i<DB.ventas.length;i++){ var ym=(DB.ventas[i].fecha||"").slice(0,7); if(ym) mesesConVentas[ym]=true; }
    var candidatos=Object.keys(mesesConVentas).sort();
    for(var i=candidatos.length-1;i>=0;i--){
      var yaArch=false;
      for(var j=0;j<DB.archivo.length;j++) if(DB.archivo[j].mes===candidatos[i]){ yaArch=true; break; }
      if(!yaArch){ ymCerrar=candidatos[i]; break; }
    }
  }

  // ¿Ese mes ya esta cerrado (archivado)?
  var yaCerrado=false;
  for(var i=0;i<DB.archivo.length;i++) if(DB.archivo[i].mes===ymCerrar){ yaCerrado=true; break; }

  // ¿Tiene ventas ese mes? (si no, no hay nada que cerrar)
  var tieneVentas=false;
  for(var i=0;i<DB.ventas.length;i++){ if((DB.ventas[i].fecha||"").slice(0,7)===ymCerrar){ tieneVentas=true; break; } }
  // Tambien contar abonos de apartados de ese mes
  if(!tieneVentas){
    for(var i=0;i<DB.apartados.length;i++){ var ab=DB.apartados[i].abonos||[]; for(var j=0;j<ab.length;j++) if((ab[j].fecha||"").slice(0,7)===ymCerrar){ tieneVentas=true; break; } if(tieneVentas) break; }
  }

  // Estados de los pasos
  var descargado=(window._mesesDescargados&&window._mesesDescargados[ymCerrar])?true:false;
  // ¿Hay piezas vendidas en cero pendientes de limpiar?
  var cerosPendientes=0;
  for(var i=0;i<DB.items.length;i++) if((DB.items[i].cantidad||0)===0) cerosPendientes++;

  var nombreM=nombreMes(ymCerrar);

  if(yaCerrado){
    var h2='<div class="h3" style="margin-bottom:6px">Cierre de mes</div>';
    h2+='<div style="padding:10px;background:#141a10;border:1px solid #3a4a20;border-radius:8px;color:#a3c76d;font-size:13px">El mes <b>'+nombreM+'</b> ya esta cerrado y archivado. Nada pendiente por ahora.</div>';
    el.innerHTML=h2;
    return;
  }
  if(!tieneVentas){
    el.innerHTML='<div class="h3" style="margin-bottom:6px">Cierre de mes</div><div class="sm mut" style="padding:10px">No hay ventas registradas en '+nombreM+' que requieran cierre.</div>';
    return;
  }

  function fila(ok, texto, detalle){
    var icono=ok?'<span style="color:#4ade80">&#10004;</span>':'<span style="color:#f59e0b">&#9675;</span>';
    return '<div style="display:flex;gap:9px;padding:6px 0;border-bottom:1px solid #1e1c18"><div style="font-size:15px;width:18px;text-align:center">'+icono+'</div><div style="flex:1"><div style="font-size:13px;color:'+(ok?"#8a8578":"#f0ebe3")+'">'+texto+'</div>'+(detalle?'<div class="sm mut">'+detalle+'</div>':'')+'</div></div>';
  }
  function boton(texto, onclick, activo, colorAlt){
    var estilo = activo ? (colorAlt?('color:'+colorAlt+';border-color:'+colorAlt+'44'):'') : 'opacity:.4;pointer-events:none';
    var clase = activo && !colorAlt ? "btna" : "btno";
    return '<button class="'+clase+'" style="'+estilo+'" onclick="'+onclick+'">'+texto+'</button>';
  }

  // Respaldo de HOY: la red de seguridad se verifica al INICIO, antes de tocar nada
  // irreversible (cerrar mes, limpiar inventario). Un respaldo de un dia anterior
  // no cuenta: queremos la version mas fresca posible antes de empezar.
  var ultimoResp=null;
  try{ ultimoResp=localStorage.getItem("ultimoRespaldo"); }catch(e){}
  var respaldoHoyOk = ultimoResp===hoyStr.slice(0,10);

  var h='<div class="h3" style="margin-bottom:4px">Panel de cierre de mes — '+nombreM+'</div>';
  h+='<div class="sm mut" style="margin-bottom:10px">Sigue estos pasos EN ORDEN. Cada boton se activa cuando corresponde.</div>';

  h+=fila(true, "1. Revisa y corrige las ventas del mes", "Cancela cualquier venta equivocada ANTES de continuar. Se hace desde el historial de abajo.");
  h+=fila(respaldoHoyOk, "2. Respalda", respaldoHoyOk?("Respaldo de hoy hecho ("+ultimoResp+")."):"Tu red de seguridad: si algo falla en los pasos siguientes, este respaldo te permite recuperar todo.");
  h+=fila(descargado, "3. Descarga el CSV del mes", descargado?"Descargado.":"Conserva el detalle completo de las ventas.");
  h+=fila(false, "4. Genera los reportes", "Reporte general de ventas y reporte de consignatarios del mes.");
  h+=fila(yaCerrado, "5. Cierra el mes", "La deuda por proveedor queda calculada y fija en este paso.");
  h+=fila(false, "6. Limpia las piezas vendidas del inventario", cerosPendientes>0?(cerosPendientes+" pieza(s) en cero."):"Sin piezas en cero pendientes.");

  // Botones EN SECUENCIA, en el mismo orden que los pasos de arriba.
  h+='<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">';
  h+='<div style="display:flex;gap:8px;flex-wrap:wrap">'+boton("2. Respaldar ahora","respaldar()",!respaldoHoyOk)+'</div>';
  h+='<div style="display:flex;gap:8px;flex-wrap:wrap">'+boton("3. Descargar CSV del mes",'descargarMes("'+ymCerrar+'")',!descargado)+'</div>';
  h+='<div style="display:flex;gap:8px;flex-wrap:wrap">'+boton("4. Reporte general de ventas","reporteGeneralVentas()",descargado)+boton("4. Reporte de consignatarios","reporteConsignatarios()",descargado)+'</div>';
  h+='<div style="display:flex;gap:8px;flex-wrap:wrap">'+boton("5. Cerrar el mes",'cerrarMes("'+ymCerrar+'")',descargado&&!yaCerrado)+'</div>';
  h+='<div style="display:flex;gap:8px;flex-wrap:wrap">'+boton("6. Limpiar vendidos de todos los proveedores","limpiarCerosTodos()",yaCerrado,"#f59e0b")+'</div>';
  h+='</div>';

  el.innerHTML=h;
}

function RMeses(){
  var el=ge("rmeses"); if(!el) return;
  var pagoColor={"efectivo":"#4ade80","tarjeta":"#818cf8","transferencia":"#f59e0b"};
  var pagoLabel={"efectivo":"Efectivo","tarjeta":"Tarjeta","transferencia":"Transferencia"};
  // Group sales by month
  var meses={};
  for(var i=0;i<DB.ventas.length;i++){
    var v=DB.ventas[i];
    var ym=(v.fecha||"").slice(0,7);
    if(!ym) continue;
    if(!meses[ym]) meses[ym]=[];
    meses[ym].push(v);
  }
  var claves=Object.keys(meses).sort().reverse();
  if(!claves.length){
    el.innerHTML='<div style="text-align:center;padding:26px;color:#4a4540">Sin ventas activas. Los meses cerrados estan en el desempeno mensual.</div>';
    return;
  }
  var mesActual=diaComercial().slice(0,7); // solo el mes corriente permite cancelar desde Reportes
  var h="";
  for(var m=0;m<claves.length;m++){
    var ym=claves[m], vts=meses[ym];
    var esMesActual=(ym===mesActual);
    var totalMes=0,ventasMes=0,piezasMes=0;
    for(var i=0;i<vts.length;i++){
      var v=vts[i];
      totalMes+=v.total;
      if(!v.cancelacion){ ventasMes++; for(var j=0;j<v.lineas.length;j++) if(!v.lineas[j].cancelada) piezasMes+=v.lineas[j].cantidad; }
    }
    var abierto=m===0; // primer mes abierto por defecto
    h+='<div class="box" style="margin-bottom:11px">';
    h+='<div onclick="toggleMes(\''+ym+'\')" style="display:flex;justify-content:space-between;align-items:center;padding:13px 15px;cursor:pointer;background:#141210">';
    h+='<div style="display:flex;align-items:center;gap:9px"><span id="mes-arrow-'+ym+'" style="color:#6b6358">'+(abierto?"&#9660;":"&#9654;")+'</span><span style="font-family:Georgia,serif;font-size:15px;color:#c9a96e">'+nombreMes(ym)+'</span><span class="sm mut">'+ventasMes+' ventas &middot; '+piezasMes+' piezas</span></div>';
    h+='<span style="font-weight:700;color:#c9a96e;font-size:16px">'+fmt(totalMes)+'</span>';
    h+='</div>';
    h+='<div id="mes-body-'+ym+'" style="display:'+(abierto?"block":"none")+'">';
    h+='<div style="padding:8px 13px;border-top:1px solid #2a2620;display:flex;gap:8px;flex-wrap:wrap">';
    h+='<button class="btn btns" onclick="descargarMes(\''+ym+'\')">Descargar mes (CSV)</button>';
    h+='<button class="btnr" style="padding:5px 11px;font-size:11px" onclick="cerrarMes(\''+ym+'\')">Cerrar y archivar mes</button>';
    h+='</div>';
    h+='<div class="tw"><table class="tbl"><thead><tr><th>Fecha</th><th>Pago</th><th>Total</th><th>Prendas vendidas</th></tr></thead><tbody>';
    for(var i=0;i<vts.length;i++){
      var v=vts[i], mp2=v.mpago||"efectivo";
      var rowBg2=v.cancelacion?"#1a0a0a":(i%2?"#0d0c0a":"");
      var apaT=v.esApartado?' <span class="pill" style="background:#f59e0b22;color:#f59e0b;font-size:9px">APARTADO</span>':'';
      var totalDisp2=v.cancelacion?'<span style="color:#f87171;font-size:11px">DEVOLUCION '+fmt(Math.abs(v.total))+'</span>':'<span class="gold">'+fmt(v.total)+'</span>'+apaT;
      var det2=""; for(var k=0;k<v.lineas.length;k++){var lk=v.lineas[k],itk=getItem(lk.itemId);
        var cancelBtn2=lk.cancelada?'<span style="color:#f87171;font-size:10px;margin-left:6px">CANCELADA</span>':((v.cancelacion||!esMesActual)?'':'<button onclick="cancelarVenta(\''+v.id+'\','+k+')" style="background:none;border:1px solid #f8717144;border-radius:4px;color:#f87171;font-size:10px;padding:1px 6px;cursor:pointer;margin-left:6px">Cancelar</button>');
        det2+='<div style="font-size:11px;line-height:1.5;display:flex;align-items:center;flex-wrap:wrap"><span class="mono" style="color:'+(lk.cancelada?"#6b6358":"#c9a96e")+';text-decoration:'+(lk.cancelada?"line-through":"none")+';margin-right:6px">'+esc(itk?itk.sku:"?")+'</span><span class="mut">'+esc(itk?itk.descripcion:"eliminada")+'</span><span style="color:#4ade80;margin-left:4px">'+fmt(lk.precio*lk.cantidad)+'</span>'+cancelBtn2+'</div>';}
      h+='<tr style="background:'+rowBg2+';vertical-align:top"><td class="mut" style="white-space:nowrap">'+v.fecha+'</td><td><span style="color:'+(pagoColor[mp2]||"#a09480")+';font-size:12px">'+(pagoLabel[mp2]||mp2)+'</span></td><td style="white-space:nowrap">'+totalDisp2+'</td><td>'+det2+'</td></tr>';
    }
    h+='</tbody></table></div></div></div>';
  }
  el.innerHTML=h;
}

function toggleMes(ym){
  var body=ge("mes-body-"+ym), arrow=ge("mes-arrow-"+ym);
  if(!body) return;
  if(body.style.display==="none"){ body.style.display="block"; if(arrow) arrow.innerHTML="&#9660;"; }
  else { body.style.display="none"; if(arrow) arrow.innerHTML="&#9654;"; }
}

function descargarMes(ym){
  var provName={}; for(var i=0;i<DB.provs.length;i++) provName[DB.provs[i].id]=DB.provs[i].nombre;
  function cell(v){var s=String(v==null?"":v);if(s.indexOf('"')!==-1)s=s.replace(/"/g,'""');if(s.indexOf(",")!==-1||s.indexOf('"')!==-1||s.indexOf("\n")!==-1)s='"'+s+'"';return s;}
  var rows=[["Fecha","Clave","Descripcion","Proveedor","Cantidad","Precio unitario","Total linea","Metodo de pago","Tipo"].join(",")];
  var count=0;
  for(var i=0;i<DB.ventas.length;i++){
    var v=DB.ventas[i];
    if((v.fecha||"").slice(0,7)!==ym) continue;
    var tipo=v.cancelacion?"DEVOLUCION":(v.esApartado?"APARTADO":"VENTA");
    for(var k=0;k<v.lineas.length;k++){
      var l=v.lineas[k], it=getItem(l.itemId);
      rows.push([cell(v.fecha),cell(it?it.sku:"?"),cell(it?it.descripcion:"eliminada"),cell(it?(provName[it.proveedorId]||""):""),cell(l.cantidad),cell(l.precio),cell(l.precio*l.cantidad*(v.cancelacion?-1:1)),cell(v.mpago||"efectivo"),cell(tipo)].join(","));
      count++;
    }
  }
  if(!count){ alert("No hay ventas en "+nombreMes(ym)); return; }
  var csv="\ufeff"+rows.join("\r\n");
  var blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a"); a.href=url; a.download="arcana-ventas-"+ym+".csv"; a.click();
  URL.revokeObjectURL(url);
  // Mark this month as downloaded (for the cerrarMes guard)
  if(!window._mesesDescargados) window._mesesDescargados={};
  window._mesesDescargados[ym]=true;
  apaOkGlobal("Mes "+nombreMes(ym)+" descargado. Ahora puedes cerrarlo.");
  RChecklist();
}

function apaOkGlobal(msg){
  // Reuse a transient message if available, else alert
  var s=ge("apa-ok");
  if(s){ s.textContent=msg; s.style.display="block"; setTimeout(function(){s.style.display="none";},2600); }
  else console.log(msg);
}

function cerrarMes(ym){
  // Require download first
  if(!window._mesesDescargados||!window._mesesDescargados[ym]){
    alert("Debes descargar el mes antes de cerrarlo.\n\nUsa el boton \"Descargar mes (CSV)\" primero. Asi conservas el detalle completo de las ventas.");
    return;
  }
  // Compute month summary
  var pagoTot={efectivo:0,tarjeta:0,transferencia:0};
  var totalMes=0,ventasMes=0,piezasMes=0,ingr=0,cost=0,accIva=0,accIsr=0,accTerm=0,devol=0;
  var porProv={};
  var restantes=[];
  for(var i=0;i<DB.ventas.length;i++){
    var v=DB.ventas[i];
    if((v.fecha||"").slice(0,7)!==ym){ restantes.push(v); continue; }
    var mp=v.mpago||"efectivo";
    totalMes+=v.total;
    if(v.cancelacion){
      devol+=Math.abs(v.total);
      var fc=fiscal(Math.abs(v.total),mp); accIva-=fc.iva; accIsr-=fc.isr; accTerm-=fc.term;
      pagoTot[mp]=(pagoTot[mp]||0)+v.total;
    } else if(v.esApartado){
      // La venta de apartado representa la pieza cubierta totalmente ESTE mes (fecha de liquidacion).
      // El ingreso NO se cuenta aqui (viene de los abonos, contados abajo por su fecha).
      // La deuda al proveedor (costo/porProv) SI se cristaliza aqui: la pieza se completo este mes.
      ventasMes++;
      for(var j=0;j<v.lineas.length;j++){
        if(v.lineas[j].cancelada) continue;
        piezasMes+=v.lineas[j].cantidad;
        var lin=v.lineas[j];
        // Usar el proveedor/costo GUARDADO EN LA LINEA (capturado al momento de vender/liquidar).
        // Esto hace el cierre independiente del inventario: funciona aunque la pieza ya se haya
        // eliminado del inventario (por "Limpiar ceros") antes de cerrar el mes.
        var provId=lin.proveedorId, costoP=lin.costoProveedor;
        if(provId===undefined){ // compatibilidad con ventas antiguas sin el dato en la linea
          var itFallback=getItem(lin.itemId);
          provId=itFallback?itFallback.proveedorId:null; costoP=itFallback?(itFallback.costoProveedor||0):0;
        }
        if(provId){
          var pvTipo=getProv(provId); var esConsig=pvTipo&&pvTipo.tipo==="consignacion";
          if(esConsig){
            cost+=(costoP||0)*lin.cantidad;
            porProv[provId]=(porProv[provId]||0)+(costoP||0)*lin.cantidad;
          }
        }
      }
    } else {
      ventasMes++; ingr+=v.total;
      pagoTot[mp]=(pagoTot[mp]||0)+v.total;
      var fv=fiscal(v.total,mp); accIva+=fv.iva; accIsr+=fv.isr; accTerm+=fv.term;
      for(var j=0;j<v.lineas.length;j++){
        if(v.lineas[j].cancelada) continue;
        piezasMes+=v.lineas[j].cantidad;
        var lin=v.lineas[j];
        var provId=lin.proveedorId, costoP=lin.costoProveedor;
        if(provId===undefined){
          var itFallback=getItem(lin.itemId);
          provId=itFallback?itFallback.proveedorId:null; costoP=itFallback?(itFallback.costoProveedor||0):0;
        }
        if(provId){
          var pvTipo2=getProv(provId); var esConsig2=pvTipo2&&pvTipo2.tipo==="consignacion";
          if(esConsig2){
            cost+=(costoP||0)*lin.cantidad;
            porProv[provId]=(porProv[provId]||0)+(costoP||0)*lin.cantidad;
          }
        }
      }
    }
  }
  // INGRESO POR ABONOS: cada abono cuenta como ingreso en el MES DE SU FECHA,
  // sin importar el estado actual del apartado (activo, resguardo, liquidado, abandonado).
  // Se EXCLUYEN los cancelados: su dinero va a saldo a favor, no a ingreso por venta.
  // Como cada mes solo mira las fechas de ESE mes, nunca hay doble conteo.
  var abonoParcialMes=0; // abonos de apartados que aun NO se completan (informativo)
  for(var i=0;i<DB.apartados.length;i++){
    var apa=DB.apartados[i];
    if(apa.estado==="cancelado"||!apa.abonos) continue;
    for(var j=0;j<apa.abonos.length;j++){
      var ab=apa.abonos[j];
      if((ab.fecha||"").slice(0,7)!==ym) continue;
      var mpa=ab.mpago||"efectivo";
      ingr+=ab.monto||0; pagoTot[mpa]=(pagoTot[mpa]||0)+(ab.monto||0);
      var fa=fiscal(ab.monto||0,mpa); accIva+=fa.iva; accIsr+=fa.isr; accTerm+=fa.term;
      // Informativo: abono de un apartado que al cierre aun NO se ha completado (sigue activo/resguardo pendiente)
      if(apa.estado==="activo") abonoParcialMes+=ab.monto||0;
    }
  }
  // SALDO A FAVOR RETENIDO: saldos que EXPIRARON este mes sin usarse = ingreso del negocio.
  // No pasan por proveedor (esa pieza ya se conto o se cancelo). Es ingreso puro retenido.
  var saldoRetenidoMes=0;
  for(var i=0;i<(DB.saldos||[]).length;i++){
    var sa=DB.saldos[i];
    if(sa.usado) continue;
    if(!sa.fechaVencimiento) continue;
    if((sa.fechaVencimiento||"").slice(0,7)!==ym) continue;
    if(sa.fechaVencimiento>=hoy()) continue; // aun no expira
    if(sa.contabilizadoRetenido) continue; // ya se conto en un cierre previo
    saldoRetenidoMes+=sa.monto||0;
    sa.contabilizadoRetenido=true; // marcar para no recontar
  }
  if(saldoRetenidoMes>0){
    ingr+=saldoRetenidoMes;
    pagoTot["efectivo"]=(pagoTot["efectivo"]||0)+saldoRetenidoMes; // se asume retenido como efectivo
  }
  var ganancia=ingr-accIva-accIsr-accTerm-cost;
  if(!confirm("Cerrar "+nombreMes(ym)+"?\n\nTotal: "+fmt(totalMes)+"\nVentas: "+ventasMes+" | Piezas: "+piezasMes+"\n\nLas ventas de este mes saldran de los totales activos y su resumen quedara guardado en el desempeno mensual. Esta accion no se puede deshacer (pero ya tienes el CSV descargado).")) return;
  // Save summary to archivo
  DB.archivo.push({
    mes:ym, total:totalMes, ventas:ventasMes, piezas:piezasMes,
    ingreso:ingr, costo:cost, ganancia:ganancia,
    iva:accIva, isr:accIsr, term:accTerm, devoluciones:devol,
    efectivo:pagoTot.efectivo||0, tarjeta:pagoTot.tarjeta||0, transferencia:pagoTot.transferencia||0,
    porProveedor:porProv,
    abonoParcial:abonoParcialMes,
    saldoRetenido:saldoRetenidoMes,
    cerradoEl:hoy()
  });
  // Remove this month's sales from active data
  DB.ventas=restantes;
  window._mesesDescargados[ym]=false;
  dbSave(); RR();
  apaOkGlobal(nombreMes(ym)+" cerrado y archivado.");
}

// Grafica de desempeno mensual (barras) - combina meses activos + archivados
function RGrafica(){
  var el=ge("rgrafica"); if(!el) return;
  // Build monthly totals from active sales
  var activos={};
  for(var i=0;i<DB.ventas.length;i++){
    var v=DB.ventas[i]; if(v.cancelacion) continue;
    var ym=(v.fecha||"").slice(0,7); if(!ym) continue;
    activos[ym]=(activos[ym]||0)+v.total;
  }
  // Merge with archived summaries
  var todos={};
  for(var k in activos) todos[k]=activos[k];
  for(var i=0;i<DB.archivo.length;i++){
    var a=DB.archivo[i];
    todos[a.mes]=(todos[a.mes]||0)+(a.total||0);
  }
  var claves=Object.keys(todos).sort();
  if(!claves.length){
    el.innerHTML='<div style="text-align:center;padding:20px;color:#4a4540">Aun no hay datos para graficar</div>';
    return;
  }
  // Only show last 12 months
  if(claves.length>12) claves=claves.slice(claves.length-12);
  var maxVal=0; for(var i=0;i<claves.length;i++) if(todos[claves[i]]>maxVal) maxVal=todos[claves[i]];
  if(maxVal<=0) maxVal=1;
  var h='<div style="display:flex;align-items:flex-end;gap:8px;height:180px;padding:10px 0;overflow-x:auto">';
  for(var i=0;i<claves.length;i++){
    var ym=claves[i], val=todos[ym];
    var pct=Math.round((val/maxVal)*100);
    var esArchivado=false; for(var j=0;j<DB.archivo.length;j++) if(DB.archivo[j].mes===ym){esArchivado=true;break;}
    var barColor=esArchivado?"#6b6358":"#c9a96e";
    var p=ym.split("-");
    var etq=MESES_ES[parseInt(p[1])-1].slice(0,3)+" "+p[0].slice(2);
    h+='<div style="display:flex;flex-direction:column;align-items:center;gap:5px;min-width:52px;flex:1">';
    h+='<div style="font-size:10px;color:#a09480;white-space:nowrap">'+fmt(val)+'</div>';
    h+='<div style="width:100%;max-width:44px;height:'+Math.max(4,pct*1.2)+'px;background:'+barColor+';border-radius:4px 4px 0 0;transition:height .3s"></div>';
    h+='<div style="font-size:10px;color:#6b6358;white-space:nowrap">'+etq+'</div>';
    h+='</div>';
  }
  h+='</div>';
  h+='<div class="sm mut" style="text-align:center;margin-top:6px"><span style="color:#c9a96e">&#9632;</span> Mes activo &nbsp; <span style="color:#6b6358">&#9632;</span> Mes archivado</div>';
  el.innerHTML=h;
}

// ── ETIQUETAS ────────────────────────────────────────────────────────────────
function makeTag(it){
  // Optimizada para Xprinter XP-365B: termica directa 203 DPI, etiqueta 50x28mm.
  // Sin codigo de barras (lector pendiente a futuro). Negro puro para impresion termica nitida.
  var sk=esc(it.sku||"");
  var css='@page{size:50mm 28mm;margin:0}*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,Helvetica,sans-serif}';
  css+='.tag{width:50mm;height:28mm;padding:2mm 3mm;page-break-after:always;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;overflow:hidden}';
  css+='.tc{font-size:10pt;font-weight:700;font-family:\'Courier New\',monospace;color:#000;letter-spacing:0.5pt;margin-bottom:1.5mm}';
  css+='.tp{font-size:26pt;font-weight:900;color:#000;line-height:1;letter-spacing:-0.5pt}';
  css+='.tt{font-size:9pt;font-weight:700;color:#000;margin-top:1.5mm;letter-spacing:0.5pt}';
  return {sku:sk, precio:fmt(it.precioVenta), talla:esc(it.talla||""), css:css};
}
function printTags(items, copies){
  if(!items.length){alert("Selecciona al menos una prenda");return;}
  var t=makeTag(items[0]); // get css from first item
  var tags="";
  for(var r=0;r<copies;r++){
    for(var i=0;i<items.length;i++){
      var d=makeTag(items[i]);
      tags+='<div class="tag"><div class="tc">'+d.sku+(d.talla?' &middot; '+d.talla:'')+'</div><span class="tp">'+d.precio+'</span></div>';
    }
  }
  var doc='<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'+t.css+'<\/style><\/head><body>'+tags+'<\/body><\/html>';
  var w=window.open("","_blank","width=480,height=480");
  if(!w){alert("Permite ventanas emergentes para imprimir");return;}
  w.document.write(doc); w.document.close();
  w.onload=function(){ setTimeout(function(){ w.print(); },250); };
}

// Etiquetas publicas
function EPB(){
  epbRenderLista((ge("epb-busq")||{}).value||"");
}
function epbRenderLista(q){
  q=(q||"").toLowerCase();
  var el=ge("epb-lista"); if(!el) return;
  el.innerHTML="";
  var vis=[],count=0;
  for(var i=0;i<DB.items.length&&count<80;i++){
    var it=DB.items[i];
    if((it.cantidad||0)<1) continue;
    if(!q||String(it.sku||"").toLowerCase().indexOf(q)!==-1||String(it.descripcion||"").toLowerCase().indexOf(q)!==-1){ vis.push(it); count++; }
  }
  if(!vis.length){ el.innerHTML='<div style="padding:30px;text-align:center;color:#4a4540">Sin prendas disponibles</div>'; epbPrev(); return; }
  for(var i=0;i<vis.length;i++){
    (function(item,idx){
      var s=epbSel[item.id]?true:false;
      var div=document.createElement("div");
      div.style.cssText="display:flex;align-items:center;gap:9px;padding:7px 13px;border-bottom:1px solid #1e1c18;cursor:pointer;background:"+(s?"#1a2318":(idx%2===0?"":"#0d0c0a"));
      div.innerHTML='<div style="width:15px;height:15px;border-radius:4px;border:1.5px solid '+(s?"#4ade80":"#2a2620")+';background:'+(s?"rgba(74,222,128,.2)":"transparent")+';flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:9px;color:#4ade80">'+(s?"v":"")+'</div>'+
        '<span class="mono gold" style="min-width:80px;font-size:12px">'+esc(item.sku)+'</span>'+
        '<span style="flex:1;font-size:13px">'+esc(item.descripcion)+'</span>'+
        '<span class="gold sm">'+fmt(item.precioVenta)+'</span>';
      div.addEventListener("click",function(){ epbToggle(item.id); });
      el.appendChild(div);
    })(vis[i],i);
  }
  epbPrev();
}
function epbToggle(id){ if(epbSel[id]) delete epbSel[id]; else epbSel[id]=true; epbRenderLista((ge("epb-busq")||{}).value||""); }
function epbAll(){ for(var i=0;i<DB.items.length;i++) if((DB.items[i].cantidad||0)>0) epbSel[DB.items[i].id]=true; epbRenderLista(""); }
function epbNone(){ epbSel={}; epbRenderLista(""); }
function epbPrev(){
  var sel=[]; for(var i=0;i<DB.items.length;i++) if(epbSel[DB.items[i].id]) sel.push(DB.items[i]);
  var cp=parseInt((ge("epb-cp")||{}).value)||1;
  var h=""; for(var i=0;i<Math.min(sel.length,2);i++){
    var it=sel[i];
    h+='<div style="background:#fff;border-radius:5px;padding:8px 6px;margin-bottom:7px;color:#000;width:150px;display:flex;flex-direction:column;gap:3px;align-items:center;text-align:center">';
    h+='<div style="font-size:9px;font-weight:700;font-family:monospace;letter-spacing:0.5px">'+esc(it.sku)+'</div>';
    h+='<div style="font-size:24px;font-weight:900;line-height:1">'+fmt(it.precioVenta)+'</div>';
    h+='</div>';
  }
  if(sel.length>2) h+='<div class="sm mut" style="margin-bottom:9px">...y '+(sel.length-2)+' mas</div>';
  var ep=ge("epb-prev"); if(ep) ep.innerHTML=h;
  var btn=ge("epb-btn"); if(btn) btn.textContent="Imprimir "+(sel.length*cp)+" etiqueta"+(sel.length*cp!==1?"s":"");
}
function epbImprimir(){
  var sel=[]; for(var i=0;i<DB.items.length;i++) if(epbSel[DB.items[i].id]) sel.push(DB.items[i]);
  var cp=parseInt((ge("epb-cp")||{}).value)||1;
  printTags(sel,cp);
}
function eFromInv(id){
  reqAdmin("etiq-pub",ge("btn-etiq-pub"));
  epbSel={}; epbSel[id]=true; epbRenderLista("");
}

// ── IMPORTAR ──────────────────────────────────────────────────────────────────
function parseTSV(txt){
  var sep=(txt.split("\n")[0]||"").indexOf("\t")!==-1?"\t":",";
  var lines=txt.split(/\r?\n/),result=[];
  for(var i=0;i<lines.length;i++){
    if(!lines[i].trim()) continue;
    if(sep==="\t"){ result.push(lines[i].split("\t").map(function(c){ return c.trim(); })); }
    else{ var cells=[],cur="",inQ=false,line=lines[i]; for(var ci=0;ci<line.length;ci++){var ch=line[ci];if(ch==='"'){if(inQ&&line[ci+1]==='"'){cur+='"';ci++;}else inQ=!inQ;}else if(ch===","&&!inQ){cells.push(cur.trim());cur="";}else cur+=ch;} cells.push(cur.trim()); result.push(cells); }
  }
  return result;
}
function parseFecha(v){
  if(!v&&v!==0) return "";
  var s=String(v).trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var dmy=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if(dmy){ var y=dmy[3].length===2?"20"+dmy[3]:dmy[3]; return y+"-"+dmy[2].padStart(2,"0")+"-"+dmy[1].padStart(2,"0"); }
  var n=parseFloat(s); if(!isNaN(n)&&n>1000&&n<60000) return new Date((n-25569)*86400*1000).toISOString().slice(0,10);
  return s;
}
function fhdr(hdr,cands){
  var h=[]; for(var i=0;i<hdr.length;i++) h.push(String(hdr[i]||"").toLowerCase().trim());
  for(var c=0;c<cands.length;c++) for(var i=0;i<h.length;i++) if(h[i].indexOf(cands[c])!==-1) return i;
  return -1;
}
function impProvChg(){
  // Al elegir proveedor existente: ocultar campos de nuevo proveedor y mostrar su tipo (automatico)
  var sel=(ge("imp-prov")||{}).value;
  var divNuevo=ge("imp-nuevo-prov"), info=ge("imp-tipo-info");
  if(!divNuevo||!info) return;
  if(sel==="__n"){
    divNuevo.style.display="block";
    info.style.display="none";
  } else {
    divNuevo.style.display="none";
    var pv=getProv(sel);
    if(pv){
      var tipoLabel=pv.tipo==="consignacion"?"Consignacion":"Compra directa";
      info.innerHTML='Tipo del proveedor: <b style="color:'+(pv.tipo==="consignacion"?"#f59e0b":"#4ade80")+'">'+tipoLabel+'</b> (asignado automaticamente)';
      info.style.display="block";
    }
  }
}
function aImp(){
  var po='<option value="__n">+ Crear nuevo proveedor</option>';
  for(var i=0;i<DB.provs.length;i++) po+='<option value="'+DB.provs[i].id+'">'+esc(DB.provs[i].nombre)+'</option>';
  var instruc='<div style="background:#0f0e0c;border:1px solid #4ade8033;border-radius:8px;padding:12px;margin-bottom:14px;font-size:13px;line-height:1.9">';
  instruc+='<strong style="color:#c9a96e">Como importar:</strong><br>';
  instruc+='1. En Excel selecciona las filas de datos (con o sin encabezados)<br>';
  instruc+='2. Copia con <strong style="color:#4ade80">Ctrl+C</strong><br>';
  instruc+='3. Pega abajo con <strong style="color:#4ade80">Ctrl+V</strong><br>';
  instruc+='<span style="color:#6b6358">Si incluyes encabezados el sistema detecta columnas automaticamente.</span></div>';
  var form='<div class="fld"><label class="lbl">Proveedor</label><select class="inp" id="imp-prov" onchange="impProvChg()">'+po+'</select></div>';
  form+='<div id="imp-nuevo-prov"><div class="g2">';
  form+='<div class="fld"><label class="lbl">Nombre del nuevo proveedor</label><input class="inp" id="imp-nom" placeholder="Nombre del proveedor"/></div>';
  form+='<div class="fld"><label class="lbl">Tipo</label><select class="inp" id="imp-tipo"><option value="consignacion">Consignacion</option><option value="compra_directa">Compra directa</option></select></div>';
  form+='</div></div>';
  form+='<div id="imp-tipo-info" class="sm mut" style="display:none;margin-bottom:12px"></div>';
  form+='<div class="fld"><label class="lbl" style="color:#c9a96e">Orden de columnas si pegas SIN encabezados (separadas por coma):<br><span style="color:#6b6358;font-weight:400">Ej: clave, descripcion, costo, precio, epoca, notas &nbsp;|&nbsp; Dejar vacio si pegas CON encabezados</span></label>';
  form+='<input class="inp" id="imp-orden" placeholder="Ej: clave, descripcion, costo, precio, epoca, notas" style="font-size:12px"/></div>';
  form+='<div class="fld"><label class="lbl">Pega aqui el contenido (Ctrl+V)</label>';
  form+='<textarea class="inp" id="imp-txt" rows="8" placeholder="Haz clic aqui y pega con Ctrl+V..." style="font-family:monospace;font-size:11px;resize:vertical"></textarea></div>';
  form+='<div id="imp-prev" style="font-size:12px;min-height:18px;margin-bottom:10px"></div>';
  form+='<div style="display:flex;justify-content:space-between;padding-top:7px">';
  form+='<button class="btn" onclick="CM()">Cancelar</button>';
  form+='<button class="btna" onclick="doImp()">Importar prendas</button></div>';
  OM("Importar inventario",instruc+form);
  var ta=ge("imp-txt");
  if(ta){ ta.addEventListener("input",impPrev); ta.addEventListener("paste",function(){ setTimeout(impPrev,150); }); }
}
function impPrev(){
  var txt=(ge("imp-txt")||{}).value||"";
  var prev=ge("imp-prev"); if(!prev) return;
  if(!txt.trim()){prev.textContent="";return;}
  var rows=parseTSV(txt);
  var orden=(ge("imp-orden")||{}).value||"";
  var valid=rows.length-(orden.trim()?"0":"1")*1;
  if(valid<0) valid=0;
  var muestra=rows[0]?rows[0].slice(0,4).map(function(c){ return esc(String(c||"")); }).join(", "):"";
  prev.innerHTML='<span style="color:#4ade80">'+(orden.trim()?"Sin encabezados":"Encabezados: "+muestra)+" | Prendas a importar: "+valid+'</span>';
}
function normCat(raw){
  var s=String(raw||"").trim();
  if(!s) return "";
  var low=s.toLowerCase();
  for(var i=0;i<CATS.length;i++){
    if(CATS[i].toLowerCase()===low) return CATS[i];
  }
  // partial match
  for(var i=0;i<CATS.length;i++){
    var cl=CATS[i].toLowerCase();
    if(low.indexOf(cl)!==-1||cl.indexOf(low)!==-1) return CATS[i];
  }
  // capitalize first letter as fallback
  return s.charAt(0).toUpperCase()+s.slice(1).toLowerCase();
}
function normEp(raw){
  var s=String(raw||"").trim();
  if(!s) return "";
  var low=s.toLowerCase().replace(/\s/g,"");
  for(var i=0;i<EPOCAS.length;i++){
    if(EPOCAS[i].toLowerCase().replace(/\s/g,"")===low) return EPOCAS[i];
  }
  // match "1960", "60s", "1960s" -> "1960s"
  var m=low.match(/(\d{4})/);
  if(m){ for(var i=0;i<EPOCAS.length;i++){ if(EPOCAS[i].indexOf(m[1])!==-1) return EPOCAS[i]; } }
  return s;
}
function normTalla(raw){
  if(!raw) return "";
  var s=String(raw).trim().toLowerCase().replace(/\s/g,"");
  var map={
    "xch":"Xch","xchica":"Xch","xs":"Xch","extrachica":"Xch","xchico":"Xch",
    "ch":"Ch","chica":"Ch","s":"Ch","chico":"Ch","small":"Ch",
    "ch/m":"Ch/M","chm":"Ch/M","s/m":"Ch/M",
    "m":"M","mediana":"M","mediano":"M","medium":"M",
    "m/g":"M/G","mg":"M/G","m/l":"M/G",
    "g":"G","grande":"G","l":"G","large":"G",
    "xg":"XG","xgrande":"XG","xl":"XG","extragrande":"XG"
  };
  if(map[s]) return map[s];
  // Si ya viene exactamente como una talla oficial, respetarla
  for(var i=0;i<TALLAS.length;i++) if(TALLAS[i].toLowerCase()===s) return TALLAS[i];
  return ""; // no reconocida: se deja vacia
}
function doImp(){
  var txt=(ge("imp-txt")||{}).value||"";
  if(!txt.trim()){alert("Pega el contenido de tu Excel primero");return;}
  var rows=parseTSV(txt);
  if(!rows.length){alert("No se detectaron datos.");return;}
  var provId=ge("imp-prov").value,newProv=null;
  if(provId==="__n"){var pn=ge("imp-nom").value.trim();if(!pn){alert("Escribe el nombre del proveedor");return;}provId=uid();newProv={id:provId,nombre:pn,tipo:ge("imp-tipo").value,telefono:"",notas:"Importado"};}
  var pv=newProv||getProv(provId),pnm=pv?pv.nombre:"IMP";
  var orden=(ge("imp-orden")||{}).value||"";
  var hdr,dataStart;
  if(orden.trim()){
    hdr=orden.split(",").map(function(s){ return s.trim().toLowerCase(); }); dataStart=0;
  } else {
    hdr=rows[0].map(function(c){ return String(c||"").trim().toLowerCase(); }); dataStart=1;
  }
  var iCl=fhdr(hdr,["clave","sku","codigo","code","id","folio"]);
  var iDs=fhdr(hdr,["descripcion","descripci","desc","nombre","prenda","pieza","articulo"]);
  var iCo=fhdr(hdr,["costo proveedor","costo del proveedor","precio proveedor","pide","solicita","compra","costo","cost"]);
  var iPv=fhdr(hdr,["precio de venta","precio venta","venta","precio","sale","pvp"]);
  var iEp=fhdr(hdr,["epoca","decada","periodo","era","ano","year"]);
  var iCt=fhdr(hdr,["categoria","clase"]);
  var iTl=fhdr(hdr,["talla","tallas","size","medida"]);
  var iNo=fhdr(hdr,["nota","notas","comentario","obs"]);
  var iQt=fhdr(hdr,["cantidad","cant.","cant","qty","stock","piezas","unidades","existencia","pzs","pz"]);
  var iFi=fhdr(hdr,["fecha ingreso","fecha de ingreso","ingreso","fecha entrada","fecha"]);
  function gv(row,idx){ return idx>=0&&idx<row.length?String(row[idx]||"").trim():""; }
  function gn(row,idx){ var v=parseFloat(gv(row,idx).replace(/[$,\s]/g,"")); return isNaN(v)?0:v; }
  var allI=[];
  for(var ri=dataStart;ri<rows.length;ri++){
    var row=rows[ri],ok=false; for(var ci=0;ci<row.length;ci++) if(String(row[ci]||"").trim()){ok=true;break;} if(!ok) continue;
    var cant=iQt>=0?Math.round(gn(row,iQt)):1; if(cant<1) cant=1;
    var fRaw=iFi>=0?gv(row,iFi):"";
    var skuVal=iCl>=0?gv(row,iCl):"";
    if(!skuVal) skuVal=pnm.slice(0,3).toUpperCase()+"-"+String(ri).padStart(4,"0");
    var catRaw=iCt>=0?gv(row,iCt):"";var catNorm=normCat(catRaw);var epRaw=iEp>=0?gv(row,iEp):"";var epNorm=normEp(epRaw);var tlRaw=iTl>=0?gv(row,iTl):"";var tlNorm=normTalla(tlRaw);allI.push({id:uid(),sku:skuVal,descripcion:iDs>=0?gv(row,iDs):"",categoria:catNorm,epoca:epNorm,talla:tlNorm,cantidad:cant,cantidadInicial:cant,proveedorId:provId,costoProveedor:iCo>=0?gn(row,iCo):0,precioVenta:iPv>=0?gn(row,iPv):0,fechaIngreso:fRaw?parseFecha(fRaw):hoy(),notas:iNo>=0?gv(row,iNo):""});
  }
  if(!allI.length){alert("No se encontraron prendas.");return;}
  var exS={}; for(var i=0;i<DB.items.length;i++) exS[DB.items[i].sku]=true;
  var dups=[]; for(var i=0;i<allI.length;i++) if(exS[allI[i].sku]) dups.push(allI[i].sku);
  if(dups.length&&!confirm(dups.length+" clave(s) ya existen: "+dups.slice(0,5).join(", ")+". Continuar?")) return;
  if(newProv) DB.provs.push(newProv);
  for(var i=0;i<allI.length;i++) DB.items.push(allI[i]);
  dbSave(); CM(); RI();
  alert("Importadas "+allI.length+" prendas"+(newProv?" y proveedor "+newProv.nombre:"")+".");
}

// ══════════════════════════════════════════════════════════════════════════════
// APARTADOS (LAYAWAY)
// ══════════════════════════════════════════════════════════════════════════════
// apartado = {id, fecha, fechaLimite, clienteNombre, clienteContacto, itemId, sku,
//   descripcion, precio, abonos:[{fecha,monto,mpago}], estado:"activo"|"liquidado"|"vencido",
//   ventaId (cuando se liquida)}
// saldo = {id, clienteNombre, clienteContacto, monto, fechaVencimiento, origen(apartadoId), usado:false}

function apaAbonado(apa){
  var t=0; if(apa.abonos) for(var i=0;i<apa.abonos.length;i++) t+=apa.abonos[i].monto||0; return t;
}
function apaAdeudo(apa){ return Math.max(0,(apa.precio||0)-apaAbonado(apa)); }
function apaPiezas(apa){
  if(apa.piezas && apa.piezas.length) return apa.piezas;
  if(apa.itemId) return [{itemId:apa.itemId, sku:apa.sku, descripcion:apa.descripcion, precio:apa.precio}];
  return [];
}
function apaPiezasTexto(apa){
  var pz=apaPiezas(apa);
  if(pz.length===1) return esc(pz[0].sku)+" - "+esc(pz[0].descripcion||"");
  return pz.length+" piezas";
}
function apaVencido(apa){
  return apa.estado==="activo" && apa.fechaLimite && apa.fechaLimite < hoy();
}
function apaEstadoReal(apa){
  if(apa.estado==="liquidado") return "liquidado";
  if(apaVencido(apa)) return "vencido";
  return "activo";
}

// ── ALERTA DE APARTADOS POR VENCER (2 dias o menos) ──
function apartadosPorVencer(){
  var hoyC=diaComercial();
  var lim=new Date(hoyC); lim.setDate(lim.getDate()+2);
  var limStr=lim.getFullYear()+"-"+String(lim.getMonth()+1).padStart(2,"0")+"-"+String(lim.getDate()).padStart(2,"0");
  var res=[];
  for(var i=0;i<(DB.apartados||[]).length;i++){
    var a=DB.apartados[i];
    if(a.estado!=="activo") continue;
    if(!a.fechaLimite) continue;
    if(a.fechaLimite>=hoyC && a.fechaLimite<=limStr) res.push(a);
  }
  return res;
}
function alertaApaVistos(){
  try{ return JSON.parse(localStorage.getItem("apaAlertaVistos")||"{}"); }catch(e){ return {}; }
}
function revisarAlertaApa(){
  var el=ge("apa-alerta"); if(!el) return;
  var porVencer=apartadosPorVencer();
  var vistos=alertaApaVistos();
  // Solo apartados que NO han sido marcados como vistos
  var pendientes=porVencer.filter(function(a){ return !vistos[a.id]; });
  if(!pendientes.length){ el.style.display="none"; return; }
  var txt=ge("apa-alerta-txt");
  txt.textContent=pendientes.length===1?"1 apartado por vencer":pendientes.length+" apartados por vencer";
  txt.onclick=function(){ toggleAlertaLista(pendientes); };
  el.style.display="block";
  // Guardar los pendientes actuales para el boton cerrar
  window._alertaApaActual=pendientes;
}
function toggleAlertaLista(pendientes){
  var lst=ge("apa-alerta-lista"); if(!lst) return;
  if(lst.style.display==="none"){
    var h="";
    for(var i=0;i<pendientes.length;i++){
      var a=pendientes[i];
      h+='<div style="padding:3px 0;color:#a09480"><b style="color:#f0ebe3">'+esc(a.clienteNombre)+'</b> &middot; vence '+a.fechaLimite+'</div>';
    }
    lst.innerHTML=h;
    lst.style.display="block";
  } else {
    lst.style.display="none";
  }
}
function cerrarAlertaApa(){
  // Marcar los apartados actuales como vistos (no vuelven a alertar)
  var vistos=alertaApaVistos();
  var actuales=window._alertaApaActual||[];
  for(var i=0;i<actuales.length;i++) vistos[actuales[i].id]=true;
  try{ localStorage.setItem("apaAlertaVistos",JSON.stringify(vistos)); }catch(e){}
  var el=ge("apa-alerta"); if(el) el.style.display="none";
  var lst=ge("apa-alerta-lista"); if(lst) lst.style.display="none";
}

function apartarCarrito(){
  if(!carrito.length){ alert("Agrega prendas al carrito primero"); return; }
  var subtotal=0; for(var i=0;i<carrito.length;i++) subtotal+=carrito[i].precio*carrito[i].cant;
  // Aplicar el descuento del carrito (si hay uno activo) al precio total sugerido del apartado.
  var descValA=parseFloat((ge("cdesc")||{}).value)||0;
  var descTipoA=(ge("cdesc-tipo")||{}).value||"monto";
  if(descValA<0) descValA=0;
  var descMontoA=0;
  if(descTipoA==="pct"){ if(descValA>100) descValA=100; descMontoA=subtotal*(descValA/100); }
  else { if(descValA>subtotal) descValA=subtotal; descMontoA=descValA; }
  var total=Math.max(0,subtotal-descMontoA);
  var limDefault=new Date(Date.now()+15*86400*1000).toISOString().slice(0,10);
  var lista='<div style="background:#0f0e0c;border:1px solid #2a2620;border-radius:8px;padding:10px;margin-bottom:12px;max-height:150px;overflow-y:auto">';
  for(var i=0;i<carrito.length;i++){
    var l=carrito[i];
    lista+='<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px"><span><span class="mono gold">'+esc(l.item.sku)+'</span> '+esc(l.item.descripcion||"")+(l.cant>1?' x'+l.cant:'')+'</span><span class="gold">'+fmt(l.precio*l.cant)+'</span></div>';
  }
  lista+='</div>';
  if(descMontoA>0) lista=lista.replace('</div>', '<div style="display:flex;justify-content:space-between;padding:5px 0 0;font-size:12px;border-top:1px solid #2a2620;margin-top:5px"><span class="mut">Descuento aplicado'+(descTipoA==="pct"?" ("+descValA+"%)":"")+'</span><span style="color:#f87171">-'+fmt(descMontoA)+'</span></div></div>');
  var h=lista;
  h+='<div class="g2">';
  h+='<div class="fld"><label class="lbl">Cliente</label><input class="inp" id="apac-cli" placeholder="Nombre del cliente"/></div>';
  h+='<div class="fld"><label class="lbl">Contacto</label><input class="inp" id="apac-con" placeholder="Telefono, IG, etc."/></div>';
  h+='</div>';
  h+='<div class="g2">';
  h+='<div class="fld"><label class="lbl">Precio total acordado</label><input type="number" class="inp" id="apac-precio" value="'+Math.round(total)+'" oninput="apacChkAnticipo()"/></div>';
  h+='<div class="fld"><label class="lbl">Fecha limite</label><input type="date" class="inp" id="apac-limite" value="'+limDefault+'"/></div>';
  h+='</div>';
  h+='<div class="g2">';
  h+='<div class="fld"><label class="lbl">Anticipo inicial</label><input type="number" class="inp" id="apac-anticipo" placeholder="0" oninput="apacChkAnticipo()"/></div>';
  h+='<div class="fld"><label class="lbl">Metodo del anticipo</label><select class="inp" id="apac-mpago"><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option></select></div>';
  h+='</div>';
  h+='<div class="fld"><label class="lbl">Notas</label><input class="inp" id="apac-notas" placeholder="Opcional"/></div>';
  h+='<div id="apac-err" style="color:#f87171;font-size:12px;min-height:16px;margin-bottom:6px"></div>';
  h+='<div style="display:flex;justify-content:space-between;padding-top:6px;gap:8px;flex-wrap:wrap"><button class="btn" onclick="CM()">Cancelar</button>';
  h+='<div style="display:flex;gap:8px">';
  h+='<button class="btno" id="apac-btn-reservar" onclick="pagarYReservarCarrito()" style="opacity:.4;pointer-events:none">Pagar y reservar</button>';
  h+='<button class="btna" onclick="guardarApartadoCarrito()">Crear apartado</button></div></div>';
  OM("Apartar carrito ("+carrito.length+" prenda"+(carrito.length>1?"s":"")+")",h);
}

function apacChkAnticipo(){
  var precio=parseFloat((ge("apac-precio")||{}).value)||0;
  var anticipo=parseFloat((ge("apac-anticipo")||{}).value)||0;
  var btn=ge("apac-btn-reservar");
  if(!btn) return;
  // Se activa solo cuando el anticipo cubre (o supera) el precio total
  if(precio>0 && anticipo>=precio){
    btn.style.opacity="1"; btn.style.pointerEvents="auto";
  } else {
    btn.style.opacity=".4"; btn.style.pointerEvents="none";
  }
}

function pagarYReservarCarrito(){
  var cli=(ge("apac-cli")||{}).value.trim();
  var con=(ge("apac-con")||{}).value.trim();
  var precio=parseFloat((ge("apac-precio")||{}).value)||0;
  var limite=(ge("apac-limite")||{}).value;
  var anticipo=parseFloat((ge("apac-anticipo")||{}).value)||0;
  var mpago=(ge("apac-mpago")||{}).value||"efectivo";
  var notas=(ge("apac-notas")||{}).value.trim();
  var err=ge("apac-err");
  if(!carrito.length){ if(err) err.textContent="El carrito esta vacio."; return; }
  if(!cli){ if(err) err.textContent="Escribe el nombre del cliente."; return; }
  if(precio<=0){ if(err) err.textContent="El precio debe ser mayor a cero."; return; }
  if(anticipo<precio){ if(err) err.textContent="El anticipo debe cubrir el total para usar 'Pagar y reservar'."; return; }
  for(var i=0;i<carrito.length;i++){
    var it=getItem(carrito[i].id);
    if(!it||(it.cantidad||0)<carrito[i].cant){ if(err) err.textContent="Sin existencia suficiente de "+carrito[i].item.sku+"."; return; }
  }
  var piezas=[];
  for(var i=0;i<carrito.length;i++){
    var l=carrito[i], it=getItem(l.id);
    for(var c=0;c<l.cant;c++){
      piezas.push({itemId:it.id, sku:it.sku, descripcion:it.descripcion, precio:l.precio});
    }
    it.cantidad=Math.max(0,(it.cantidad||0)-l.cant);
  }
  // El pago completo se registra como el abono (cubre el total)
  var abonos=[{fecha:diaComercial(),monto:precio,mpago:mpago}];
  var apa={
    id:uid(), fecha:hoy(), fechaLimite:limite,
    clienteNombre:cli, clienteContacto:con,
    piezas:piezas, precio:precio, abonos:abonos, estado:"activo", notas:notas
  };
  DB.apartados.unshift(apa);
  carrito=[];
  if(ge("cdesc")) ge("cdesc").value="0";
  // Liquidar directamente a RESGUARDO (registra la venta como ingreso, deja ficha en resguardo)
  liquidarApartado(apa, true);
  CM(); RC(); RApa();
  var s=ge("pok"); if(s){ s.textContent="Venta registrada. "+cli+" en resguardo para entrega."; s.style.display="block"; setTimeout(function(){ s.style.display="none"; s.textContent="Venta registrada correctamente"; },2800); }
}

function guardarApartadoCarrito(){
  var cli=(ge("apac-cli")||{}).value.trim();
  var con=(ge("apac-con")||{}).value.trim();
  var precio=parseFloat((ge("apac-precio")||{}).value)||0;
  var limite=(ge("apac-limite")||{}).value;
  var anticipo=parseFloat((ge("apac-anticipo")||{}).value)||0;
  var mpago=(ge("apac-mpago")||{}).value||"efectivo";
  var notas=(ge("apac-notas")||{}).value.trim();
  var err=ge("apac-err");
  if(!carrito.length){ if(err) err.textContent="El carrito esta vacio."; return; }
  if(!cli){ if(err) err.textContent="Escribe el nombre del cliente."; return; }
  if(precio<=0){ if(err) err.textContent="El precio debe ser mayor a cero."; return; }
  if(anticipo>precio){ if(err) err.textContent="El anticipo no puede superar el precio."; return; }
  for(var i=0;i<carrito.length;i++){
    var it=getItem(carrito[i].id);
    if(!it||(it.cantidad||0)<carrito[i].cant){ if(err) err.textContent="Sin existencia suficiente de "+carrito[i].item.sku+"."; return; }
  }
  var piezas=[];
  for(var i=0;i<carrito.length;i++){
    var l=carrito[i], it=getItem(l.id);
    for(var c=0;c<l.cant;c++){
      piezas.push({itemId:it.id, sku:it.sku, descripcion:it.descripcion, precio:l.precio});
    }
    it.cantidad=Math.max(0,(it.cantidad||0)-l.cant);
  }
  var abonos=[];
  if(anticipo>0) abonos.push({fecha:diaComercial(),monto:anticipo,mpago:mpago});
  var apa={
    id:uid(), fecha:hoy(), fechaLimite:limite,
    clienteNombre:cli, clienteContacto:con,
    piezas:piezas, precio:precio, abonos:abonos, estado:"activo", notas:notas
  };
  DB.apartados.unshift(apa);
  carrito=[];
  if(ge("cdesc")) ge("cdesc").value="0";
  dbSave(); CM(); RC();
  var s=ge("pok"); if(s){ s.textContent="Apartado creado para "+cli+" ("+piezas.length+" piezas)"; s.style.display="block"; setTimeout(function(){ s.style.display="none"; s.textContent="Venta registrada correctamente"; },2800); }
}

function apaOk(msg){
  var s=ge("apa-ok"); if(!s) return;
  s.textContent=msg; s.style.display="block";
  setTimeout(function(){ s.style.display="none"; },2600);
}

function abonarApartado(apaId){
  var apa=null; for(var i=0;i<DB.apartados.length;i++) if(DB.apartados[i].id===apaId){apa=DB.apartados[i];break;}
  if(!apa) return;
  var adeudo=apaAdeudo(apa);
  var pagado = adeudo<=0.5;
  var h='<div class="sm mut" style="margin-bottom:12px">Cliente: <b style="color:#f0ebe3">'+esc(apa.clienteNombre)+'</b><br>Piezas: '+apaPiezasTexto(apa)+'<br>Precio: '+fmt(apa.precio)+' &middot; Abonado: '+fmt(apaAbonado(apa))+' &middot; Adeudo: <b style="color:'+(pagado?"#4ade80":"#f59e0b")+'">'+fmt(adeudo)+'</b></div>';
  if(pagado) h+='<div style="margin-bottom:12px;padding:8px 10px;background:#141a10;border:1px solid #3a4a20;border-radius:6px;font-size:12px;color:#a3c76d">Este apartado ya esta pagado por completo. Puedes liquidarlo directamente (sin registrar mas abonos).</div>';
  h+='<div class="g2">';
  h+='<div class="fld"'+(pagado?' style="opacity:.5"':'')+'><label class="lbl">Monto del abono</label><input type="number" class="inp" id="ab-monto" placeholder="0" value="'+(pagado?0:adeudo)+'"'+(pagado?' disabled':'')+'/></div>';
  h+='<div class="fld"><label class="lbl">Metodo de pago</label><select class="inp" id="ab-mpago"><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option></select></div>';
  h+='</div>';
  h+='<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#a09480;margin-bottom:6px"><input type="checkbox" id="ab-liquidar" checked style="accent-color:#c9a96e;width:15px;height:15px"/> Si este abono completa el pago, liquidar y convertir en venta</label>';
  h+='<div id="ab-err" style="color:#f87171;font-size:12px;min-height:16px;margin-bottom:6px"></div>';
  h+='<div style="display:flex;justify-content:space-between;padding-top:6px"><button class="btn" onclick="CM()">Cancelar</button><button class="btna" onclick="guardarAbono(\''+apaId+'\')">'+(pagado?"Liquidar venta":"Registrar abono")+'</button></div>';
  OM("Registrar abono",h);
}

function guardarAbono(apaId){
  var apa=null; for(var i=0;i<DB.apartados.length;i++) if(DB.apartados[i].id===apaId){apa=DB.apartados[i];break;}
  if(!apa) return;
  var monto=parseFloat((ge("ab-monto")||{}).value)||0;
  var mpago=(ge("ab-mpago")||{}).value||"efectivo";
  var liquidar=(ge("ab-liquidar")||{}).checked;
  var err=ge("ab-err");
  var adeudo=apaAdeudo(apa);
  // Permitir monto 0 SOLO si el apartado ya esta pagado y se quiere liquidar (caso venta en linea ya cubierta)
  if(monto<=0 && !(adeudo<=0.5 && liquidar)){ if(err) err.textContent="El monto debe ser mayor a cero."; return; }
  if(monto>adeudo+0.5){ if(err) err.textContent="El abono supera el adeudo ("+fmt(adeudo)+")."; return; }
  if(!apa.abonos) apa.abonos=[];
  if(monto>0){
    apa.abonos.push({fecha:diaComercial(),monto:monto,mpago:mpago});
    dbSave(); // Guardar el abono INMEDIATAMENTE para que no se pierda al continuar al flujo de entrega
  }
  var nuevoAdeudo=apaAdeudo(apa);
  if(nuevoAdeudo<=0.5 && liquidar){
    // El pago esta completo: ofrecer entregar ahora o dejar en resguardo (venta en linea)
    CM();
    elegirEntregaApartado(apa.id);
  } else {
    dbSave(); apaOk("Abono de "+fmt(monto)+" registrado."); CM(); RApa();
  }
}

function liquidarApartado(apa, aResguardo){
  apa.estado = aResguardo ? "resguardo" : "liquidado";
  apa.fechaLiquidado=hoy();
  var ventaId=uid();
  apa.ventaId=ventaId;
  var piezas=apaPiezas(apa);
  var lineas=[];
  var agrup={};
  for(var i=0;i<piezas.length;i++){
    var pz=piezas[i];
    if(!agrup[pz.itemId]){
      var itP=getItem(pz.itemId);
      agrup[pz.itemId]={itemId:pz.itemId,cantidad:0,precio:pz.precio,
        proveedorId:itP?itP.proveedorId:null, costoProveedor:itP?(itP.costoProveedor||0):0};
    }
    agrup[pz.itemId].cantidad++;
  }
  for(var k in agrup) lineas.push(agrup[k]);
  var venta={
    id:ventaId, fecha:diaComercial(), ts:ahora(),
    lineas:lineas,
    total:apa.precio,
    mpago:(apa.abonos&&apa.abonos.length?apa.abonos[apa.abonos.length-1].mpago:"efectivo"),
    esApartado:true, apartadoId:apa.id,
    abonos:apa.abonos?apa.abonos.slice():[]
  };
  DB.ventas.unshift(venta);
  dbSave();
}

function cancelarApartado(apaId){
  var apa=null,idx=-1; for(var i=0;i<DB.apartados.length;i++) if(DB.apartados[i].id===apaId){apa=DB.apartados[i];idx=i;break;}
  if(!apa) return;
  var abonado=apaAbonado(apa);
  var piezas=apaPiezas(apa);
  var msg="Cancelar el apartado de "+apa.clienteNombre+"?\n\nLas "+piezas.length+" pieza(s) regresaran al inventario.";
  if(abonado>0) msg+="\n\nEl cliente abono "+fmt(abonado)+". Se registrara como saldo a favor por 15 dias que el negocio conserva.";
  if(!confirm(msg)) return;
  for(var pi=0;pi<piezas.length;pi++){
    var it=getItem(piezas[pi].itemId);
    if(it) it.cantidad=(it.cantidad||0)+1;
  }
  // Register saldo a favor if there was any payment
  if(abonado>0){
    var venc=new Date(Date.now()+15*86400*1000).toISOString().slice(0,10);
    // Conservar referencia de las piezas que originaron el saldo (clave + descripcion)
    var piezasRef=[];
    for(var pr=0;pr<piezas.length;pr++) piezasRef.push({sku:piezas[pr].sku, descripcion:piezas[pr].descripcion||""});
    var piezasTexto=piezasRef.map(function(x){ return x.sku; }).join(", ");
    DB.saldos.unshift({
      id:uid(), clienteNombre:apa.clienteNombre, clienteContacto:apa.clienteContacto,
      monto:abonado, fechaVencimiento:venc, origen:apa.id, usado:false, fecha:hoy(),
      piezas:piezasRef, piezasTexto:piezasTexto
    });
  }
  // Mark apartado as cancelled (keep for history)
  apa.estado="cancelado";
  apa.fechaCancelado=hoy();
  dbSave(); RApa();
  apaOk("Apartado cancelado. Piezas devueltas al inventario.");
}

function usarSaldo(saldoId){
  var s=null; for(var i=0;i<DB.saldos.length;i++) if(DB.saldos[i].id===saldoId){s=DB.saldos[i];break;}
  if(!s) return;
  if(!confirm("Marcar el saldo de "+fmt(s.monto)+" de "+s.clienteNombre+" como usado?")) return;
  s.usado=true; s.fechaUsado=hoy();
  dbSave(); RApa();
  apaOk("Saldo marcado como usado.");
}

function editarApartado(apaId){
  var apa=null; for(var i=0;i<DB.apartados.length;i++) if(DB.apartados[i].id===apaId){apa=DB.apartados[i];break;}
  if(!apa) return;
  var h='<div class="g2">';
  h+='<div class="fld"><label class="lbl">Cliente</label><input class="inp" id="ed-cli" value="'+esc(apa.clienteNombre||"")+'"/></div>';
  h+='<div class="fld"><label class="lbl">Contacto</label><input class="inp" id="ed-con" value="'+esc(apa.clienteContacto||"")+'"/></div>';
  h+='</div>';
  h+='<div class="g2">';
  h+='<div class="fld"><label class="lbl">Precio acordado</label><input type="number" class="inp" id="ed-precio" value="'+(apa.precio||0)+'"/></div>';
  h+='<div class="fld"><label class="lbl">Fecha limite</label><input type="date" class="inp" id="ed-limite" value="'+(apa.fechaLimite||"")+'"/></div>';
  h+='</div>';
  h+='<div class="fld"><label class="lbl">Notas</label><input class="inp" id="ed-notas" value="'+esc(apa.notas||"")+'"/></div>';
  h+='<div class="sm mut" style="margin-bottom:8px">Piezas: '+apaPiezasTexto(apa)+'. Para cambiar las piezas, elimina este apartado y crea uno nuevo desde el POS.</div>';
  h+='<div id="ed-err" style="color:#f87171;font-size:12px;min-height:16px;margin-bottom:6px"></div>';
  h+='<div style="display:flex;justify-content:space-between;padding-top:6px"><button class="btn" onclick="CM()">Cancelar</button><button class="btna" onclick="guardarEdicionApartado(\''+apaId+'\')">Guardar cambios</button></div>';
  OM("Editar apartado",h);
}

function guardarEdicionApartado(apaId){
  var apa=null; for(var i=0;i<DB.apartados.length;i++) if(DB.apartados[i].id===apaId){apa=DB.apartados[i];break;}
  if(!apa) return;
  var cli=(ge("ed-cli")||{}).value.trim();
  var precio=parseFloat((ge("ed-precio")||{}).value)||0;
  var err=ge("ed-err");
  if(!cli){ if(err) err.textContent="El nombre del cliente es obligatorio."; return; }
  if(precio<=0){ if(err) err.textContent="El precio debe ser mayor a cero."; return; }
  var abonado=apaAbonado(apa);
  if(precio<abonado){ if(err) err.textContent="El precio no puede ser menor a lo ya abonado ("+fmt(abonado)+")."; return; }
  apa.clienteNombre=cli;
  apa.clienteContacto=(ge("ed-con")||{}).value.trim();
  apa.precio=precio;
  apa.fechaLimite=(ge("ed-limite")||{}).value;
  apa.notas=(ge("ed-notas")||{}).value.trim();
  dbSave(); CM(); RApa();
  apaOk("Apartado actualizado.");
}

function elegirEntregaApartado(apaId){
  var apa=null; for(var i=0;i<DB.apartados.length;i++) if(DB.apartados[i].id===apaId){apa=DB.apartados[i];break;}
  if(!apa) return;
  var h='<div class="sm mut" style="margin-bottom:14px">El pago de <b style="color:#f0ebe3">'+esc(apa.clienteNombre)+'</b> esta completo ('+fmt(apa.precio)+'). La venta se registrara como ingreso.<br><br>Elige como continuar:</div>';
  h+='<div style="display:flex;flex-direction:column;gap:10px">';
  h+='<button class="btna" style="padding:11px" onclick="confirmarEntrega(\''+apaId+'\',false)">Entregar ahora (cerrar venta)</button>';
  h+='<div class="sm mut" style="text-align:center;margin:-4px 0">— o —</div>';
  h+='<button class="btno" style="padding:11px" onclick="confirmarEntrega(\''+apaId+'\',true)">Dejar en resguardo (venta en linea)</button>';
  h+='<div class="sm mut" style="font-size:11px;text-align:center">El resguardo mantiene la ficha del cliente hasta que marques la pieza como entregada o abandonada.</div>';
  h+='</div>';
  OM("Pago completo - "+esc(apa.clienteNombre), h);
}
function confirmarEntrega(apaId, aResguardo){
  var apa=null; for(var i=0;i<DB.apartados.length;i++) if(DB.apartados[i].id===apaId){apa=DB.apartados[i];break;}
  if(!apa) return;
  liquidarApartado(apa, aResguardo);
  CM(); RApa();
  if(aResguardo) apaOk("Venta registrada. Pieza en resguardo para entrega.");
  else apaOk("Apartado liquidado y convertido en venta.");
}
function marcarEntregado(apaId){
  var apa=null,idx=-1; for(var i=0;i<DB.apartados.length;i++) if(DB.apartados[i].id===apaId){apa=DB.apartados[i];idx=i;break;}
  if(!apa) return;
  if(!confirm("Marcar como ENTREGADO el pedido de "+apa.clienteNombre+"?\n\nLa venta permanece registrada como ingreso. La ficha del apartado se eliminara.")) return;
  // La venta ya esta registrada (se hizo al liquidar a resguardo). Solo eliminamos la ficha.
  DB.apartados.splice(idx,1);
  dbSave(); RApa();
  apaOk("Pedido entregado. Ficha cerrada.");
}
function marcarAbandonado(apaId){
  var apa=null,idx=-1; for(var i=0;i<DB.apartados.length;i++) if(DB.apartados[i].id===apaId){apa=DB.apartados[i];idx=i;break;}
  if(!apa) return;
  var piezas=apaPiezas(apa);
  if(!confirm("Marcar como ABANDONADO el pedido de "+apa.clienteNombre+"?\n\nLa venta SIGUE contando como ingreso (no se cancela).\nLa(s) pieza(s) NO regresan a venta: quedan en cero, marcadas como abandonadas, y NO se vendera de nuevo.\nSe agregara una nota de 'Venta abandonada' en cada pieza.")) return;
  var f=hoy();
  for(var pi=0;pi<piezas.length;pi++){
    var it=getItem(piezas[pi].itemId);
    if(it){
      // La pieza NO reingresa al inventario disponible: se queda en cero (ya vendida y abandonada).
      // Agregar nota conservando la existente: "Venta abandonada [fecha] · [nota original]"
      var notaAbandono="Venta abandonada "+f;
      it.notas = it.notas && it.notas.trim() ? (notaAbandono+" · "+it.notas) : notaAbandono;
    }
  }
  // La ficha del apartado NO se elimina: pasa a estado "abandonado" para que la pieza
  // quede protegida en la limpieza de ceros del corte de mes (sigue tratada como reservada).
  apa.estado="abandonado";
  apa.fechaAbandonado=f;
  // La venta permanece intacta como ingreso.
  dbSave(); RApa(); RI();
  apaOk("Pedido abandonado. La venta sigue como ingreso; la pieza queda marcada, sin volver a venta.");
}

function eliminarApartado(apaId){
  var apa=null,idx=-1; for(var i=0;i<DB.apartados.length;i++) if(DB.apartados[i].id===apaId){apa=DB.apartados[i];idx=i;break;}
  if(!apa) return;
  var piezas=apaPiezas(apa);
  var msg="Eliminar por completo este apartado de "+apa.clienteNombre+"?\n\nEsta accion NO se puede deshacer.";
  if(apa.estado==="activo"){
    msg+="\n\nLas "+piezas.length+" pieza(s) regresaran al inventario.";
    var abonado=apaAbonado(apa);
    if(abonado>0) msg+="\nSe borraran los "+fmt(abonado)+" en abonos registrados (no se creara saldo a favor).";
  }
  if(apa.estado==="liquidado"){
    msg+="\n\nADVERTENCIA: este apartado ya se convirtio en venta. Al eliminarlo se borrara tambien esa venta de tus reportes, y las piezas NO regresan al inventario (ya se vendieron).";
  }
  if(!confirm(msg)) return;
  if(apa.estado==="activo"){
    for(var pi=0;pi<piezas.length;pi++){
      var it=getItem(piezas[pi].itemId);
      if(it) it.cantidad=(it.cantidad||0)+1;
    }
  }
  // If liquidated, remove the associated sale
  if(apa.estado==="liquidado" && apa.ventaId){
    for(var i=DB.ventas.length-1;i>=0;i--){
      if(DB.ventas[i].id===apa.ventaId){ DB.ventas.splice(i,1); break; }
    }
  }
  // Remove any saldo originated from this apartado
  for(var i=DB.saldos.length-1;i>=0;i--){
    if(DB.saldos[i].origen===apa.id) DB.saldos.splice(i,1);
  }
  // Remove the apartado
  DB.apartados.splice(idx,1);
  dbSave(); RApa();
  apaOk("Apartado eliminado.");
}

function RApa(){
  // Auto-update vencido status
  var el=ge("apa-lista"); if(!el) return;
  var filtro=(ge("apa-filtro")||{}).value||"activos";
  var q=((ge("apa-busq")||{}).value||"").toLowerCase();
  var lista=DB.apartados.filter(function(a){
    var est=apaEstadoReal(a);
    if(filtro==="activos") return a.estado==="activo" || a.estado==="resguardo";
    if(filtro==="resguardo") return a.estado==="resguardo";
    if(filtro==="vencidos") return a.estado==="activo" && est==="vencido";
    if(filtro==="liquidados") return a.estado==="liquidado";
    return true; // todos
  });
  if(q){
    lista=lista.filter(function(a){
      if((a.clienteNombre||"").toLowerCase().indexOf(q)!==-1) return true;
      if((a.clienteContacto||"").toLowerCase().indexOf(q)!==-1) return true;
      var _pz=apaPiezas(a);
      for(var _p=0;_p<_pz.length;_p++){
        if((_pz[_p].sku||"").toLowerCase().indexOf(q)!==-1) return true;
        if((_pz[_p].descripcion||"").toLowerCase().indexOf(q)!==-1) return true;
      }
      return false;
    });
  }
  if(!lista.length){
    el.innerHTML='<div style="text-align:center;padding:30px;color:#4a4540">Sin apartados en esta vista</div>';
  } else {
    var h="";
    for(var i=0;i<lista.length;i++){
      var a=lista[i];
      var est=apaEstadoReal(a);
      var abonado=apaAbonado(a), adeudo=apaAdeudo(a);
      var estColor=est==="vencido"?"#f87171":(a.estado==="liquidado"?"#4ade80":(a.estado==="resguardo"?"#a3c76d":(a.estado==="abandonado"?"#8a7a5a":"#f59e0b")));
      var estLabel=a.estado==="liquidado"?"Liquidado":(a.estado==="resguardo"?"En resguardo":(a.estado==="abandonado"?"Abandonado":(a.estado==="cancelado"?"Cancelado":(est==="vencido"?"Vencido":"Activo"))));
      h+='<div class="card" style="margin-bottom:10px;border-left:3px solid '+estColor+'">';
      h+='<div style="display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:8px">';
      h+='<div style="flex:1;min-width:180px">';
      h+='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-weight:700;font-size:15px">'+esc(a.clienteNombre)+'</span><span class="pill" style="background:'+estColor+'22;color:'+estColor+'">'+estLabel+'</span></div>';
      if(a.clienteContacto) h+='<div class="sm mut">'+esc(a.clienteContacto)+'</div>';
      var _pz=apaPiezas(a);
      if(_pz.length===1){
        h+='<div style="margin-top:5px"><span class="mono gold sm">'+esc(_pz[0].sku)+'</span> <span class="sm">'+esc(_pz[0].descripcion||"")+'</span></div>';
      } else {
        h+='<div style="margin-top:5px"><span class="sm gold">'+_pz.length+' piezas:</span>';
        for(var _p=0;_p<_pz.length;_p++) h+='<div style="margin-left:8px;font-size:11px"><span class="mono gold">'+esc(_pz[_p].sku)+'</span> <span class="mut">'+esc(_pz[_p].descripcion||"")+'</span></div>';
        h+='</div>';
      }
      h+='<div class="sm mut" style="margin-top:3px">Apartado: '+a.fecha+' &middot; Limite: '+(a.fechaLimite||"-");
      if(est==="vencido") h+=' <span style="color:#f87171">(vencido)</span>';
      h+='</div>';
      // Notas visibles directamente en la ficha (sin abrir Editar)
      if(a.notas && a.notas.trim()){
        h+='<div style="margin-top:6px;padding:6px 9px;background:#1a1610;border-left:2px solid #c9a96e;border-radius:4px;font-size:12px;color:#d8cdb8"><b style="color:#c9a96e">Nota:</b> '+esc(a.notas)+'</div>';
      }
      h+='</div>';
      h+='<div style="text-align:right;min-width:120px">';
      h+='<div style="font-size:18px;font-weight:700;color:#c9a96e">'+fmt(a.precio)+'</div>';
      h+='<div class="sm gp">Abonado: '+fmt(abonado)+'</div>';
      if(adeudo>0) h+='<div class="sm" style="color:#f59e0b">Adeudo: '+fmt(adeudo)+'</div>';
      h+='</div>';
      h+='</div>';
      // Abonos detail
      if(a.abonos&&a.abonos.length){
        h+='<div style="margin-top:8px;padding-top:8px;border-top:1px solid #1e1c18">';
        for(var j=0;j<a.abonos.length;j++){
          var ab=a.abonos[j];
          h+='<span class="sm mut" style="margin-right:12px">'+ab.fecha+': '+fmt(ab.monto)+' ('+ab.mpago+')</span>';
        }
        h+='</div>';
      }
      // Action buttons
      if(a.estado==="activo"){
        h+='<div style="display:flex;gap:7px;margin-top:11px;flex-wrap:wrap">';
        h+='<button class="btna btns" onclick="abonarApartado(\''+a.id+'\')">Registrar abono / liquidar</button>';
        h+='<button class="btno" style="padding:4px 11px;font-size:11px" onclick="editarApartado(\''+a.id+'\')">Editar</button>';
        h+='<button class="btnr" style="padding:4px 11px;font-size:11px" onclick="cancelarApartado(\''+a.id+'\')">Cancelar</button>';
        h+='<button class="btnr" style="padding:4px 11px;font-size:11px" onclick="eliminarApartado(\''+a.id+'\')">Eliminar</button>';
        h+='</div>';
      } else if(a.estado==="resguardo"){
        h+='<div style="margin-top:9px;padding:8px 10px;background:#141a10;border:1px solid #3a4a20;border-radius:6px">';
        h+='<div class="sm" style="color:#a3c76d;margin-bottom:7px">En resguardo — venta registrada el '+(a.fechaLiquidado||a.fecha)+', pendiente de entrega</div>';
        h+='<div style="display:flex;gap:7px;flex-wrap:wrap">';
        h+='<button class="btna btns" onclick="marcarEntregado(\''+a.id+'\')">Entregado</button>';
        h+='<button class="btnr" style="padding:4px 11px;font-size:11px" onclick="marcarAbandonado(\''+a.id+'\')">Abandonado</button>';
        h+='</div></div>';
      } else if(a.estado==="liquidado"){
        h+='<div style="display:flex;gap:7px;margin-top:9px;flex-wrap:wrap;align-items:center">';
        h+='<span class="sm gp">Convertido en venta el '+(a.fechaLiquidado||a.fecha)+'</span>';
        h+='<button class="btnr" style="padding:3px 10px;font-size:11px" onclick="eliminarApartado(\''+a.id+'\')">Eliminar registro</button>';
        h+='</div>';
      } else if(a.estado==="cancelado"){
        h+='<div style="display:flex;gap:7px;margin-top:9px;flex-wrap:wrap;align-items:center">';
        h+='<span class="sm mut">Cancelado el '+(a.fechaCancelado||"")+' &middot; pieza devuelta</span>';
        h+='<button class="btnr" style="padding:3px 10px;font-size:11px" onclick="eliminarApartado(\''+a.id+'\')">Eliminar registro</button>';
        h+='</div>';
      } else if(a.estado==="abandonado"){
        h+='<div style="display:flex;gap:7px;margin-top:9px;flex-wrap:wrap;align-items:center">';
        h+='<span class="sm mut">Abandonado el '+(a.fechaAbandonado||"")+' &middot; venta cuenta como ingreso &middot; pieza no vuelve a venta</span>';
        h+='</div>';
      }
      h+='</div>';
    }
    el.innerHTML=h;
  }
  RSaldos();
}

function RSaldos(){
  var el=ge("apa-saldos"); if(!el) return;
  var activos=DB.saldos.filter(function(s){ return !s.usado; });
  if(!activos.length){
    el.innerHTML='<div style="text-align:center;padding:18px;color:#4a4540;font-size:13px">Sin saldos a favor pendientes</div>';
    return;
  }
  var h="";
  for(var i=0;i<activos.length;i++){
    var s=activos[i];
    var vencido=s.fechaVencimiento && s.fechaVencimiento<hoy();
    h+='<div class="card" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;'+(vencido?"opacity:.6":"")+'">';
    h+='<div><div style="font-weight:600">'+esc(s.clienteNombre)+'</div>';
    if(s.clienteContacto) h+='<div class="sm mut">'+esc(s.clienteContacto)+'</div>';
    if(s.piezasTexto) h+='<div class="sm mut">Pieza(s): <span class="gold">'+esc(s.piezasTexto)+'</span></div>';
    h+='<div class="sm mut">Vence: '+(s.fechaVencimiento||"-")+(vencido?' <span style="color:#f87171">(expirado)</span>':'')+'</div></div>';
    h+='<div style="text-align:right"><div style="font-size:17px;font-weight:700;color:#4ade80">'+fmt(s.monto)+'</div>';
    h+='<button class="btno" style="margin-top:5px" onclick="usarSaldo(\''+s.id+'\')">Marcar usado</button></div>';
    h+='</div>';
  }
  el.innerHTML=h;
}

// ── PDF ────────────────────────────────────────────────────────────────────────
function expProvPDF(){
  var po='<option value="todos">Todos los proveedores</option>';
  for(var i=0;i<DB.provs.length;i++) po+='<option value="'+DB.provs[i].id+'">'+esc(DB.provs[i].nombre)+'</option>';
  var h='<div class="g2" style="margin-bottom:12px">';
  h+='<div class="fld"><label class="lbl">Proveedor</label><select class="inp" id="pdf-prov">'+po+'</select></div>';
  h+='<div class="fld"><label class="lbl">Inventario</label><select class="inp" id="pdf-estado"><option value="todos">Disponibles y vendidos (separados)</option><option value="disponibles">Solo disponibles</option><option value="vendidos">Solo vendidos/agotados</option></select></div></div>';
  h+='<div class="fld"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#a09480"><input type="checkbox" id="pdf-ocultar-precio" style="accent-color:#c9a96e;width:15px;height:15px"/> Ocultar columna de precio de venta</label></div>';
  h+='<div class="g2" style="margin-bottom:12px"><div class="fld"><label class="lbl">Ventas desde</label><input type="date" class="inp" id="pdf-desde" value="'+hoy().slice(0,7)+'-01'+'"/></div>';
  h+='<div class="fld"><label class="lbl">Ventas hasta</label><input type="date" class="inp" id="pdf-hasta" value="'+hoy()+'"/></div></div>';
  h+='<div style="display:flex;justify-content:space-between;padding-top:7px"><button class="btn" onclick="CM()">Cancelar</button><button class="btna" onclick="generarPDF()">Generar PDF</button></div>';
  OM("Exportar PDF por proveedor",h);
}
// ══════════════ SISTEMA DE CONTRATO DE CONSIGNACION ══════════════
function editarPlantillaContrato(){
  var actual = getContratoPlantilla();
  var h='<div class="sm mut" style="margin-bottom:10px">Edita el texto del contrato. Usa estas marcas de formato:<br>'+
    '&bull; <b>#</b> al inicio de linea = titulo grande<br>'+
    '&bull; <b>##</b> al inicio de linea = subtitulo<br>'+
    '&bull; <b>**texto**</b> = negrita<br>'+
    '&bull; <b>@FIRMAS@</b> = inserta las dos lineas de firma<br>'+
    'Marcadores que se rellenan solos: <b>[PROVEEDOR]</b>, <b>[DIA]</b>, <b>[MES]</b>, <b>[ANO]</b>.</div>';
  h+='<div class="fld"><textarea class="inp" id="cpl-txt" rows="16" style="font-family:monospace;font-size:12px;line-height:1.4">'+esc(actual)+'</textarea></div>';
  h+='<div style="display:flex;justify-content:space-between;gap:8px;padding-top:8px;flex-wrap:wrap">';
  h+='<button class="btnr" onclick="restablecerPlantillaContrato()">Restablecer original</button>';
  h+='<div style="display:flex;gap:8px"><button class="btn" onclick="CM()">Cancelar</button>';
  h+='<button class="btna" onclick="guardarPlantillaContrato()">Guardar plantilla</button></div>';
  h+='</div>';
  OM("Plantilla del contrato de consignación", h);
}
function guardarPlantillaContrato(){
  var txt=(ge("cpl-txt")||{}).value||"";
  if(!txt.trim()){ alert("La plantilla no puede estar vacia."); return; }
  if(!DB.config) DB.config={};
  DB.config.contratoPlantilla=txt;
  dbSave(); CM();
  alert("Plantilla del contrato guardada. Se usara de ahora en adelante y queda incluida en tus respaldos.");
}
function restablecerPlantillaContrato(){
  if(!confirm("Restablecer la plantilla al texto original del sistema? Se perderan tus cambios personalizados.")) return;
  if(DB.config) delete DB.config.contratoPlantilla;
  dbSave(); CM();
  alert("Plantilla restablecida al texto original.");
}


var CONTRATO_PLANTILLA_DEFAULT = "# CONTRATO DE CONSIGNACIÓN\n\nEste contrato lo firman, por un lado, **[PROVEEDOR]**, a quien de aquí en adelante llamaremos \"EL PROVEEDOR\" y por otro lado, \"Jardín de Hallazgos\", representado por Ma. Luisa Torres Contreras y Laura G. Pirez Torres, con domicilio en Querétaro 22 Colonia Roma Norte CDMX, a quien llamaremos \"LA TIENDA\". Juntos, \"las Partes\", acuerdan lo siguiente:\n\n## DECLARACIONES\n\n**El PROVEEDOR declara que:**\nTiene la capacidad legal para firmar este contrato.\nEs el dueño legítimo de las piezas que entrega, que no tienen deudas ni problemas legales pendientes, y que todo lo que dice sobre ellas (marca, origen, estado) es verdad.\n\n**LA TIENDA declara que:**\nOpera el establecimiento \"Jardín de Hallazgos\", dedicado a la compraventa de ropa y artículos vintage, en el domicilio señalado al inicio de este contrato.\nCuenta con el espacio y el sistema de inventario adecuados para resguardar, exhibir y vender la mercancía en buenas condiciones.\nRecibe la mercancía únicamente para venderla por cuenta del PROVEEDOR, en los términos que se describen a continuación.\n\n## CLÁUSULAS\n\n**PRIMERA. De qué trata este contrato**\nEl PROVEEDOR entrega piezas a LA TIENDA para que ésta las ofrezca en venta a su nombre. Mientras no se vendan, esas piezas siguen siendo propiedad del PROVEEDOR; LA TIENDA únicamente las tiene bajo su resguardo para exhibirlas y venderlas.\n\n**SEGUNDA. Cómo se registra cada entrega (Anexo A)**\nCada vez que el PROVEEDOR entregue mercancía nueva, ésta quedará registrada en el Reporte de Inventario por Proveedor que genera el sistema de LA TIENDA. Ese reporte, firmado por ambas Partes al momento de cada entrega, funciona como el \"Anexo A\" de este contrato y forma parte del mismo para todos los efectos legales. En él se detalla qué piezas se entregaron, su descripción y precio de venta acordado.\nCualquier pieza que no aparezca en un reporte firmado por ambas Partes no se considera entregada en consignación bajo este contrato.\n\n**TERCERA. Cuánto dura la consignación**\nCada lote de mercancía queda en consignación por 120 días naturales a partir de la fecha de entrega registrada en el reporte correspondiente. Este plazo puede renovarse si ambas Partes lo acuerdan. Si el plazo termina sin que la pieza se haya vendido ni renovado su consignación, aplica lo que dice la cláusula de Devolución.\n\n**CUARTA. Precio**\nEl precio de pago del proveedor de cada pieza es el que se acuerde entre las Partes y quede registrado en el reporte de inventario. LA TIENDA no puede cambiar ese precio sin autorización del PROVEEDOR. Para realizar un descuento el acuerdo debe de realizarse por ambas partes por escrito, medios como Whatsapp, Instagram, correo electrónico son válidos.\n\n**QUINTA. Cuándo y cómo se paga**\nLA TIENDA le paga al PROVEEDOR lo que le corresponda dentro de los primeros 10 días de cada mes, por las piezas vendidas durante el mes anterior, mediante transferencia o efectivo, junto con un reporte de ventas que muestre qué se vendió.\n\n**SEXTA. Quién es el dueño de la mercancía**\nMientras una pieza no se venda, sigue siendo propiedad del PROVEEDOR. Que LA TIENDA la tenga en exhibición no significa que la haya comprado, cambiado o adquirido de ninguna forma; eso solo ocurre en el momento en que la pieza se vende a un cliente.\n\n**SÉPTIMA. Si algo se pierde, se daña o se lo roban**\nLA TIENDA se compromete a cuidar la mercancía con la misma atención que le da a la suya propia. Para este efecto mantiene un sistema de videovigilancia y protocolos de servicio que proveen seguridad. Si por descuido de LA TIENDA una pieza se pierde, se daña o se la roban, deberá pagarle al PROVEEDOR el valor registrado en el reporte de inventario, dentro de los siguientes 30 días naturales.\nLA TIENDA no es responsable por el desgaste normal que resulta de que los clientes se prueben las prendas, siempre que ese desgaste no se deba a un mal manejo o descuido de su parte. Tomando en consideración la naturaleza vintage de las piezas.\nEn caso de un siniestro natural o un robo a mano armada, las piezas se considerarán perdidas por ambas partes.\n\n**OCTAVA. Devolución de lo que no se vende**\nAl terminar el plazo de consignación sin que una pieza se haya vendido, LA TIENDA la pondrá a disposición del PROVEEDOR dentro de los siguientes 10 días naturales, a menos que ambas Partes acuerden por escrito extender el plazo. En caso de no recibir respuesta del proveedor y que la entrega de la mercancía falle dentro de un periodo mayor de 30 días naturales, se considerará como abandonada y se terminarán las obligaciones de resguardo de LA TIENDA.\n\n**NOVENA. Que la mercancía sea auténtica**\nEl PROVEEDOR garantiza que todo lo que informa sobre cada pieza —marca, origen, estado— es verdadero. Si se descubre que dio información falsa a propósito, él responde directamente ante LA TIENDA y ante el cliente final por los daños que esto cause, y LA TIENDA queda libre de cualquier responsabilidad por ese motivo.\n\n**DÉCIMA. Exclusividad**\nMientras la mercancía esté en consignación, el PROVEEDOR se compromete a no venderla por ningún otro medio sin autorización de LA TIENDA.\n\n**DÉCIMA PRIMERA. Fotos y publicidad**\nEl PROVEEDOR autoriza a LA TIENDA a fotografiar la mercancía y usarla en su tienda física, redes sociales, página web y demás medios de difusión de \"Jardín de Hallazgos\" así como medios afines con el fin de venderla y promocionar el inventario del negocio.\n\n**DÉCIMA SEGUNDA. Confidencialidad**\nAmbas Partes se comprometen a no compartir con terceros la información comercial o financiera que conozcan una de la otra por motivo de este contrato, salvo que una autoridad lo requiera.\n\n**DÉCIMA TERCERA. Terminación anticipada**\nCualquiera de las Partes puede dar por terminado este contrato avisando por escrito con 15 días naturales de anticipación. En ese caso, LA TIENDA debe poner la mercancía no vendida a disposición del PROVEEDOR dentro de los siguientes 10 días, como se indica en la cláusula de Devolución.\nSi alguna de las Partes incumple algo importante de este contrato —por ejemplo, no pagar lo acordado o vender a un precio no autorizado— la otra Parte puede terminarlo de inmediato, sin necesidad de aviso previo.\n\n**DÉCIMA CUARTA. Este contrato no se puede transferir**\nNinguna de las Partes puede ceder este contrato a alguien más sin el permiso, por escrito, de la otra.\n\n**DÉCIMA QUINTA. Leyes que aplican y dónde se resuelven los problemas**\nEste contrato se rige por el Código de Comercio y, en lo que no esté previsto ahí, por el Código Civil Federal y el Código Civil de la Ciudad de México.\nCualquier desacuerdo que surja de este contrato se resolverá ante los tribunales de la Ciudad de México, y ambas Partes renuncian a cualquier otro fuero que pudiera corresponderles por su domicilio actual o futuro.\n\n**DÉCIMA SEXTA. Firmas**\nEste contrato se firma por duplicado, un ejemplar para cada Parte, en la Ciudad de México, a los [DIA] días del mes de [MES] de [ANO].\n\n@FIRMAS@\n\nNota: el Anexo A de este contrato es el Reporte de Inventario por Proveedor generado por el sistema al momento de cada entrega, firmado por ambas Partes conforme a la Cláusula Segunda.";

function getContratoPlantilla(){
  return (DB.config && DB.config.contratoPlantilla) || CONTRATO_PLANTILLA_DEFAULT;
}

// Convierte el formato de marcas sencillas a HTML
function contratoParseFormato(txt){
  var lineas = txt.split("\n");
  var html = "";
  for(var i=0;i<lineas.length;i++){
    var l = lineas[i];
    var t = l.trim();
    if(t===""){ html+='<div style="height:8px"></div>'; continue; }
    if(t==="@FIRMAS@"){
      html+='<div style="margin-top:36px;display:flex;justify-content:space-between;gap:40px">';
      html+='<div style="flex:1;text-align:center"><div style="border-top:1px solid #000;margin-top:40px;padding-top:6px"><b>EL PROVEEDOR</b><br><span style="font-size:11px">Nombre y firma</span></div></div>';
      html+='<div style="flex:1;text-align:center"><div style="border-top:1px solid #000;margin-top:40px;padding-top:6px"><b>LA TIENDA</b><br><span style="font-size:11px">Jardín de Hallazgos — Nombre y firma</span></div></div>';
      html+='</div>';
      continue;
    }
    // Titulos
    if(t.indexOf("## ")===0){
      html+='<h2 style="font-size:14pt;margin:16px 0 8px;color:#000;border-bottom:1px solid #ccc;padding-bottom:3px">'+contratoInline(t.slice(3))+'</h2>';
      continue;
    }
    if(t.indexOf("# ")===0){
      html+='<h1 style="font-size:18pt;margin:0 0 12px;color:#000;text-align:center">'+contratoInline(t.slice(2))+'</h1>';
      continue;
    }
    // Parrafo normal (con negritas inline)
    html+='<p style="margin:4px 0;line-height:1.5;text-align:justify">'+contratoInline(t)+'</p>';
  }
  return html;
}
// Procesa **negrita** dentro de una linea
function contratoInline(s){
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  return s;
}

// Genera el documento del contrato para un proveedor y registra/actualiza la fecha marco
function generarContrato(provId){
  var p = getProv(provId);
  if(!p){ alert("Proveedor no encontrado"); return; }
  var nombreCompleto = (p.nombreCompleto||"").trim() || p.nombre;
  if(!(p.nombreCompleto||"").trim()){
    if(!confirm("Este proveedor no tiene 'nombre completo' capturado. Se usara el nombre corto ('"+p.nombre+"'). Te recomendamos capturar el nombre completo en la ficha. Continuar?")) return;
  }
  var hoyStr = hoy();
  // Registrar/actualizar la fecha del contrato marco
  for(var i=0;i<DB.provs.length;i++){
    if(DB.provs[i].id===provId){ DB.provs[i].fechaContrato = hoyStr; break; }
  }
  dbSave(); RP();
  // Fecha en formato largo
  var f = fechaLarga(hoyStr);
  var plantilla = getContratoPlantilla();
  plantilla = plantilla.replace(/\[PROVEEDOR\]/g, nombreCompleto)
                       .replace(/\[DIA\]/g, f.dia)
                       .replace(/\[MES\]/g, f.mes)
                       .replace(/\[ANO\]/g, f.ano);
  var cuerpo = contratoParseFormato(plantilla);
  var logoPdf = (DB.config&&DB.config.logo)||"";
  var css = '@page{margin:18mm 16mm}*{box-sizing:border-box}body{font-family:Georgia,\'Times New Roman\',serif;color:#111;font-size:11pt}';
  var doc = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'+css+'<\/style><\/head><body>';
  if(logoPdf) doc += '<div style="text-align:center;margin-bottom:8px"><img src="'+logoPdf+'" style="width:60px;height:60px;object-fit:contain"><\/div>';
  doc += cuerpo;
  doc += '<\/body><\/html>';
  var w = window.open("","_blank","width=800,height=900");
  w.document.write(doc); w.document.close();
  setTimeout(function(){ try{ w.focus(); w.print(); }catch(e){} }, 400);
}

// Convierte YYYY-MM-DD a componentes en espanol
function fechaLarga(iso){
  var meses=["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  var parts=(iso||hoy()).split("-");
  return { dia:String(parseInt(parts[2],10)), mes:meses[parseInt(parts[1],10)-1]||"", ano:parts[0] };
}


// Detecta que claves tuvieron alguna venta cancelada en el mes, con sus fechas.
// Se usa para agregar una nota de transparencia en los reportes cuando una clave
// aparece junto a una cancelacion relacionada, sin cambiar ningun calculo.
function cancelacionesPorClaveMes(ym){
  var mapa={}; // sku -> [fechas de cancelacion]
  for(var i=0;i<DB.ventas.length;i++){
    var v=DB.ventas[i];
    if(!v.cancelacion) continue;
    if((v.fecha||"").slice(0,7)!==ym) continue;
    for(var j=0;j<v.lineas.length;j++){
      var lin=v.lineas[j];
      var it=getItem(lin.itemId);
      var sku=it?it.sku:(lin.sku||lin.itemId);
      if(!mapa[sku]) mapa[sku]=[];
      mapa[sku].push(v.fecha);
    }
  }
  return mapa;
}

function reporteGeneralVentas(){
  var ym = diaComercial().slice(0,7);
  var nombreM = nombreMes(ym);
  var cancelMap = cancelacionesPorClaveMes(ym);

  // Recolectar todas las ventas del mes (activas o archivadas), excluyendo canceladas.
  // El precio de venta de cada linea se PRORRATEA con el descuento global de la venta
  // (si lo hubo), igual que en cancelarVenta, para que el reporte refleje lo realmente cobrado.
  var lineasPorProv={}; // provId -> {nombre, tipo, lineas:[], totalCosto, totalVenta}
  function agregarLinea(fecha, linea, precioEfectivo){
    if(linea.cancelada) return;
    var provId=linea.proveedorId;
    if(provId===undefined){ var itF=getItem(linea.itemId); provId=itF?itF.proveedorId:null; }
    if(!provId) return;
    var pv=getProv(provId); if(!pv) return;
    var costoU=linea.costoProveedor;
    if(costoU===undefined){ var itF2=getItem(linea.itemId); costoU=itF2?(itF2.costoProveedor||0):0; }
    var it=getItem(linea.itemId);
    var sku=it?it.sku:(linea.sku||linea.itemId);
    var desc=it?it.descripcion:(linea.descripcion||"");
    if(!lineasPorProv[provId]) lineasPorProv[provId]={nombre:pv.nombre,tipo:pv.tipo,lineas:[],totalCosto:0,totalVenta:0};
    var costo=(costoU||0)*linea.cantidad;
    var tieneCancelRel = cancelMap[sku] && cancelMap[sku].length>0;
    lineasPorProv[provId].lineas.push({fecha:fecha,sku:sku,desc:desc,cant:linea.cantidad,costo:costoU||0,venta:precioEfectivo,cancelRel:tieneCancelRel,cancelFechas:tieneCancelRel?cancelMap[sku]:null});
    lineasPorProv[provId].totalCosto+=costo;
    lineasPorProv[provId].totalVenta+=precioEfectivo*linea.cantidad;
  }
  for(var i=0;i<DB.ventas.length;i++){
    var v=DB.ventas[i];
    if((v.fecha||"").slice(0,7)!==ym) continue;
    if(v.cancelacion) continue;
    // Prorratear el descuento global de la venta entre sus lineas, segun peso en el subtotal
    var subtotalVenta=0;
    for(var k=0;k<v.lineas.length;k++) subtotalVenta+=v.lineas[k].precio*v.lineas[k].cantidad;
    var descuentoVenta=v.descuento||0;
    for(var j=0;j<v.lineas.length;j++){
      var lin=v.lineas[j];
      var precioEfectivo=lin.precio;
      if(descuentoVenta>0 && subtotalVenta>0){
        var subtotalLinea=lin.precio*lin.cantidad;
        var proporcion=subtotalLinea/subtotalVenta;
        var descuentoLinea=descuentoVenta*proporcion;
        precioEfectivo=Math.max(0,(subtotalLinea-descuentoLinea)/lin.cantidad);
      }
      agregarLinea(v.fecha, lin, precioEfectivo);
    }
  }

  var provsConsig=[], provsDirecta=[];
  for(var pid in lineasPorProv){
    var d=lineasPorProv[pid];
    if(d.tipo==="consignacion") provsConsig.push(d); else provsDirecta.push(d);
  }
  provsConsig.sort(function(a,b){ return a.nombre.localeCompare(b.nombre); });
  provsDirecta.sort(function(a,b){ return a.nombre.localeCompare(b.nombre); });

  var css='@page{size:letter;margin:10mm 12mm}*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:8.7pt;color:#1a1a1a}';
  css+='h1{font-size:16pt;color:#6b4e2e;margin-bottom:2px}.sub{font-size:8.5pt;color:#888;margin-bottom:10px;border-bottom:1.5px solid #c9a96e;padding-bottom:6px}';
  css+='h2.seccion{font-size:12.5pt;color:#fff;background:#6b4e2e;padding:4px 8px;border-radius:4px;margin:12px 0 6px;break-after:avoid}';
  css+='.grupo{break-inside:avoid;margin-bottom:8px}h3.prov{font-size:10pt;color:#4a3620;background:#f5efe4;padding:3px 7px;margin-bottom:3px;border-left:3px solid #c9a96e}';
  css+='table{width:100%;border-collapse:collapse;margin-bottom:2px;font-size:8.2pt}th{background:#faf7f1;text-align:left;padding:2px 6px;border:1px solid #ece5d6;font-size:7.8pt}';
  css+='td{padding:2px 6px;border:1px solid #f0ece2}.tot-prov{text-align:right;font-size:8.3pt;font-weight:700;color:#6b4e2e;padding:2px 4px 6px}';
  css+='.totales{margin-top:10px;font-size:11pt;font-weight:700;color:#4a3620;text-align:right}@media print{body{margin:0}}';

  var doc='<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'+css+'<\/style><\/head><body>';
  doc+='<h1>Reporte General de Ventas<\/h1><div class="sub">'+esc(nombreM)+' &middot; Ventas canceladas excluidas &middot; montos con descuentos ya aplicados &middot; Jardín de Hallazgos<\/div>';

  function renderSeccion(titulo, provs){
    doc+='<h2 class="seccion">'+esc(titulo)+'<\/h2>';
    var tc=0, tv=0;
    for(var i=0;i<provs.length;i++){
      var d=provs[i];
      d.lineas.sort(function(a,b){ return (a.fecha||"").localeCompare(b.fecha||""); });
      doc+='<div class="grupo"><h3 class="prov">'+esc(d.nombre)+'<\/h3>';
      doc+='<table><tr><th>Fecha<\/th><th>Clave<\/th><th>Descripción<\/th><th>Cant.<\/th><th>Costo<\/th><th>Venta<\/th><\/tr>';
      for(var j=0;j<d.lineas.length;j++){
        var l=d.lineas[j];
        doc+='<tr><td>'+l.fecha+'<\/td><td>'+esc(l.sku)+'<\/td><td>'+esc((l.desc||"").slice(0,36))+'<\/td><td>'+l.cant+'<\/td><td>'+fmt(l.costo)+'<\/td><td>'+fmt(l.venta)+'<\/td><\/tr>';
        if(l.cancelRel){
          doc+='<tr><td colspan="6" style="font-size:7.3pt;color:#b45309;background:#fdf3ef;padding:2px 6px;border:1px solid #ece5d6">Nota: '+esc(l.sku)+' tuvo una venta cancelada el '+l.cancelFechas.join(", ")+'; esa cancelación no está incluida en este total.<\/td><\/tr>';
        }
      }
      doc+='<\/table>';
      doc+='<div class="tot-prov">Subtotal '+esc(d.nombre)+' — Costo: '+fmt(d.totalCosto)+' &middot; Venta: '+fmt(d.totalVenta)+'<\/div><\/div>';
      tc+=d.totalCosto; tv+=d.totalVenta;
    }
    doc+='<div class="totales">Total '+esc(titulo)+' — Costo: '+fmt(tc)+' &middot; Venta: '+fmt(tv)+'<\/div>';
    return [tc,tv];
  }

  var rc=renderSeccion("Consignatarios", provsConsig);
  var rd=renderSeccion("Compra Directa", provsDirecta);
  doc+='<div class="totales" style="margin-top:14px;font-size:13pt;border-top:2px solid #6b4e2e;padding-top:8px">TOTAL GENERAL DEL MES — Costo: '+fmt(rc[0]+rd[0])+' &middot; Venta: '+fmt(rc[1]+rd[1])+'<\/div>';
  doc+='<\/body><\/html>';

  var w=window.open("","_blank","width=900,height=700");
  if(!w){ alert("Permite ventanas emergentes."); return; }
  w.document.write(doc); w.document.close();
  w.onload=function(){ setTimeout(function(){ w.print(); },400); };
}

function reporteConsignatarios(){
  var ym = diaComercial().slice(0,7);
  var nombreM = nombreMes(ym);
  var cancelMap = cancelacionesPorClaveMes(ym);

  var lineasPorProv={};
  function agregarLinea(fecha, linea){
    if(linea.cancelada) return;
    var provId=linea.proveedorId;
    if(provId===undefined){ var itF=getItem(linea.itemId); provId=itF?itF.proveedorId:null; }
    if(!provId) return;
    var pv=getProv(provId); if(!pv) return;
    if(pv.tipo!=="consignacion") return;
    var costoU=linea.costoProveedor;
    if(costoU===undefined){ var itF2=getItem(linea.itemId); costoU=itF2?(itF2.costoProveedor||0):0; }
    var it=getItem(linea.itemId);
    var sku=it?it.sku:(linea.sku||linea.itemId);
    var desc=it?it.descripcion:(linea.descripcion||"");
    if(!lineasPorProv[provId]) lineasPorProv[provId]={nombre:pv.nombre,lineas:[],total:0};
    var costo=(costoU||0)*linea.cantidad;
    var tieneCancelRel = cancelMap[sku] && cancelMap[sku].length>0;
    lineasPorProv[provId].lineas.push({fecha:fecha,sku:sku,desc:desc,cant:linea.cantidad,costo:costoU||0,cancelRel:tieneCancelRel,cancelFechas:tieneCancelRel?cancelMap[sku]:null});
    lineasPorProv[provId].total+=costo;
  }
  for(var i=0;i<DB.ventas.length;i++){
    var v=DB.ventas[i];
    if((v.fecha||"").slice(0,7)!==ym) continue;
    if(v.cancelacion) continue;
    for(var j=0;j<v.lineas.length;j++) agregarLinea(v.fecha, v.lineas[j]);
  }

  var provs=[];
  for(var pid in lineasPorProv) provs.push(lineasPorProv[pid]);
  provs.sort(function(a,b){ return a.nombre.localeCompare(b.nombre); });

  if(!provs.length){ alert("No hay ventas de consignatarios en "+nombreM+"."); return; }

  var css='@page{size:letter;margin:14mm 16mm}*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:10pt;color:#1a1a1a}';
  css+='.pagina{break-after:page;padding-top:4px}.pagina:last-child{break-after:auto}';
  css+='h1{font-size:15pt;color:#6b4e2e;margin-bottom:2px}.sub{font-size:8.5pt;color:#888;margin-bottom:14px;border-bottom:1.5px solid #c9a96e;padding-bottom:6px}';
  css+='h2{font-size:14pt;color:#4a3620;margin-bottom:10px}table{width:100%;border-collapse:collapse;margin:8px 0;font-size:9.5pt}';
  css+='th{background:#f5efe4;text-align:left;padding:5px 8px;border:1px solid #e0d6c2}td{padding:5px 8px;border:1px solid #ece5d6}';
  css+='.totales{margin-top:14px;font-size:13pt;font-weight:700;color:#4a3620;text-align:right;border-top:2px solid #c9a96e;padding-top:8px}@media print{body{margin:0}}';

  var doc='<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'+css+'<\/style><\/head><body>';
  for(var i=0;i<provs.length;i++){
    var d=provs[i];
    d.lineas.sort(function(a,b){ return (a.fecha||"").localeCompare(b.fecha||""); });
    doc+='<div class="pagina"><h1>Reporte de Consignatarios<\/h1><div class="sub">'+esc(nombreM)+' &middot; Jardín de Hallazgos<\/div>';
    doc+='<h2>'+esc(d.nombre)+'<\/h2>';
    doc+='<table><tr><th>Fecha<\/th><th>Clave<\/th><th>Descripción<\/th><th>Cant.<\/th><th>Costo<\/th><\/tr>';
    for(var j=0;j<d.lineas.length;j++){
      var l=d.lineas[j];
      doc+='<tr><td>'+l.fecha+'<\/td><td>'+esc(l.sku)+'<\/td><td>'+esc((l.desc||"").slice(0,40))+'<\/td><td>'+l.cant+'<\/td><td>'+fmt(l.costo)+'<\/td><\/tr>';
      if(l.cancelRel){
        doc+='<tr><td colspan="5" style="font-size:8pt;color:#b45309;background:#fdf3ef;padding:3px 8px;border:1px solid #ece5d6">Nota: '+esc(l.sku)+' tuvo una venta cancelada el '+l.cancelFechas.join(", ")+'; esa cancelación no está incluida en este total.<\/td><\/tr>';
      }
    }
    doc+='<\/table><div class="totales">Total a pagar: '+fmt(d.total)+'<\/div><\/div>';
  }
  doc+='<\/body><\/html>';

  var w=window.open("","_blank","width=900,height=700");
  if(!w){ alert("Permite ventanas emergentes."); return; }
  w.document.write(doc); w.document.close();
  w.onload=function(){ setTimeout(function(){ w.print(); },400); };
}

function reporteProveedor(provId){
  var p=getProv(provId);
  if(!p){ alert("Proveedor no encontrado"); return; }
  var nombreCompleto=(p.nombreCompleto||"").trim()||p.nombre;
  var disponibles=DB.items.filter(function(it){ return it.proveedorId===p.id && (it.cantidad||0)>0; });
  var hoyStr=hoy();
  // Fecha del contrato marco (de la ficha)
  var fechaMarco = p.fechaContrato ? p.fechaContrato : null;

  var css='body{font-family:Arial,sans-serif;font-size:12px;color:#111;margin:20px}';
  css+='h1{font-size:18px;margin-bottom:2px}h2{font-size:14px;margin:10px 0 8px;color:#5a3e10}';
  css+='table{width:100%;border-collapse:collapse;margin:10px 0;font-size:11px}';
  css+='th{background:#f5f0e8;padding:5px 8px;text-align:left;border:1px solid #ddd;font-size:10px}';
  css+='td{padding:4px 8px;border:1px solid #eee}tr:nth-child(even){background:#fafaf8}';
  css+='.leyenda{margin-top:18px;padding:10px 12px;background:#f9f6f0;border:1px solid #e5ddd0;border-radius:5px;font-size:10.5px;line-height:1.5;text-align:justify}';
  css+='.fechas{margin-top:14px;font-size:11px}.fechas b{color:#000}';
  css+='.firmas{margin-top:40px;display:flex;justify-content:space-between;gap:40px}';
  css+='.firma{flex:1;text-align:center}.firma .linea{border-top:1px solid #000;margin-top:36px;padding-top:5px;font-size:11px}';
  css+='@page{margin:14mm 12mm}@media print{body{margin:0}}';

  var doc='<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'+css+'<\/style><\/head><body>';
  var logoPdf=(DB.config&&DB.config.logo)||"";
  if(logoPdf) doc+='<img src="'+logoPdf+'" style="width:48px;height:48px;object-fit:contain;float:right">';
  doc+='<h1>Jardín de Hallazgos</h1>';
  doc+='<div style="font-size:12px;color:#444;margin-bottom:4px">Reporte de Inventario por Proveedor — Anexo A</div>';
  doc+='<h2>'+esc(nombreCompleto)+' <span style="font-size:11px;font-weight:400;color:#888">('+(p.tipo==="consignacion"?"Consignación":"Compra directa")+')</span></h2>';

  if(disponibles.length){
    doc+='<table><tr><th>Clave</th><th>Descripción</th><th>Talla</th><th>Cant.</th><th>Precio venta</th></tr>';
    var totalVal=0;
    for(var i=0;i<disponibles.length;i++){
      var it=disponibles[i]; totalVal+=(it.precioVenta||0)*(it.cantidad||0);
      doc+='<tr><td><b>'+esc(it.sku)+'</b></td><td>'+esc(it.descripcion||"")+'</td><td style="text-align:center">'+esc(it.talla||"")+'</td><td style="text-align:center">'+(it.cantidad||0)+'</td><td>$'+Math.round(it.precioVenta||0)+'</td></tr>';
    }
    doc+='</table>';
    doc+='<p style="font-weight:700;font-size:12px">Total de piezas: '+disponibles.length+' · Valor de venta: $'+Math.round(totalVal)+'</p>';
  } else {
    doc+='<p style="color:#999">Este proveedor no tiene piezas disponibles en inventario.</p>';
  }

  // Leyenda de Clausula Segunda
  doc+='<div class="leyenda">Este reporte forma parte integrante del Contrato de Consignación celebrado entre '+esc(nombreCompleto)+' y Jardín de Hallazgos, conforme a su Cláusula Segunda. Al firmar de conformidad, ambas partes confirman que la mercancía aquí descrita fue entregada y recibida en las condiciones señaladas.<\/div>';

  // Dos fechas
  doc+='<div class="fechas">';
  if(fechaMarco) doc+='<div>Contrato de consignación firmado el: <b>'+fechaMarco+'<\/b><\/div>';
  else doc+='<div style="color:#b45309">Contrato de consignación <b>pendiente de firma<\/b><\/div>';
  doc+='<div>Fecha de impresión de este reporte: <b>'+hoyStr+'<\/b><\/div>';
  doc+='<\/div>';

  // Lineas de firma
  doc+='<div class="firmas">';
  doc+='<div class="firma"><div class="linea">EL PROVEEDOR<\/div><\/div>';
  doc+='<div class="firma"><div class="linea">LA TIENDA (Jardín de Hallazgos)<\/div><\/div>';
  doc+='<\/div>';

  doc+='<\/body><\/html>';
  var w=window.open("","_blank","width=900,height=700");
  if(!w){alert("Permite ventanas emergentes.");return;}
  w.document.write(doc); w.document.close();
  w.onload=function(){ setTimeout(function(){ w.print(); },400); };
}

function generarPDF(){
  var provFil=ge("pdf-prov").value, estadoFil=ge("pdf-estado").value;
  var desde=ge("pdf-desde").value, hasta=ge("pdf-hasta").value;
  var oP=ge("pdf-ocultar-precio")&&ge("pdf-ocultar-precio").checked;
  var provsList=provFil==="todos"?DB.provs:DB.provs.filter(function(p){ return p.id===provFil; });
  var css='body{font-family:Arial,sans-serif;font-size:12px;color:#111;margin:20px}';
  css+='h1{font-size:18px;margin-bottom:4px}';
  css+='h2{font-size:15px;margin:22px 0 4px;padding:6px 10px;background:#f5f0e8;border-left:4px solid #c9a96e;color:#5a3e10}';
  css+='h3{font-size:12px;margin:12px 0 4px;color:#444}';
  css+='table{width:100%;border-collapse:collapse;margin-bottom:8px;font-size:11px}';
  css+='th{background:#f5f0e8;padding:5px 8px;text-align:left;border:1px solid #ddd;font-size:10px}';
  css+='td{padding:4px 8px;border:1px solid #eee}tr:nth-child(even){background:#fafaf8}';
  css+='.total{font-weight:700;font-size:13px;margin:4px 0 12px}';
  css+='.badge{display:inline-block;padding:1px 6px;border-radius:10px;font-size:10px}';
  css+='.avail{background:#e8f5e9;color:#2e7d32}.sold{background:#fce4ec;color:#c62828}';
  css+='@page{margin:12mm 10mm}';
  css+='@media print{body{margin:0}}';
  var doc='<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'+css+'<\/style><\/head><body>';
  var logoPdf=(DB.config&&DB.config.logo)||"";
  if(logoPdf) doc+='<img src="'+logoPdf+'" style="width:48px;height:48px;border-radius:8px;object-fit:cover;float:right;margin-top:-4px">';
  doc+='<h1>Jardín de Hallazgos</h1>';
  doc+='<p style="color:#666;font-size:11px;margin-bottom:4px">Reporte generado: '+hoy()+' | Ventas: '+desde+' al '+hasta+'</p>';
  var grandDisp=0,grandVentas=0;
  for(var pi=0;pi<provsList.length;pi++){
    var p=provsList[pi];
    var items=DB.items.filter(function(it){ return it.proveedorId===p.id; });
    var disponibles=items.filter(function(it){ return (it.cantidad||0)>0; });
    var agotados=items.filter(function(it){ return (it.cantidad||0)===0; });
    var ventas=DB.ventas.filter(function(v){ return !v.cancelacion&&v.fecha>=desde&&v.fecha<=hasta&&v.lineas.some(function(l){ var it=getItem(l.itemId); return it&&it.proveedorId===p.id; }); });
    var totalVentas=0;
    for(var vi=0;vi<ventas.length;vi++) for(var li=0;li<ventas[vi].lineas.length;li++){ var l=ventas[vi].lineas[li],it=getItem(l.itemId); if(it&&it.proveedorId===p.id&&!l.cancelada) totalVentas+=l.precio*l.cantidad; }
    doc+='<h2>'+esc(p.nombre)+'<span style="font-size:11px;font-weight:400;margin-left:10px;color:#888">'+(p.tipo==="consignacion"?"Consignacion":"Compra directa")+'</span></h2>';
    if(estadoFil!=="vendidos"&&disponibles.length){
      doc+='<h3><span class="badge avail">Disponibles: '+disponibles.length+' piezas</span></h3>';
      doc+='<table><tr><th>Clave</th><th>Descripcion</th><th>Cant.</th>'+(oP?'':'<th>Precio venta</th>')+'<th>Costo prov.</th><th>Fecha ingreso</th></tr>';
      var totalValDisp=0;
      for(var ii=0;ii<disponibles.length;ii++){ var it2=disponibles[ii]; totalValDisp+=(it2.precioVenta||0)*(it2.cantidad||0); doc+='<tr><td><b>'+esc(it2.sku)+'</b></td><td>'+esc(it2.descripcion)+'</td><td style="text-align:center">'+it2.cantidad+'</td>'+(oP?'':'<td><b>$'+Math.round(it2.precioVenta)+'</b></td>')+'<td>$'+Math.round(it2.costoProveedor)+'</td><td>'+esc(it2.fechaIngreso||"")+'</td></tr>'; }
      doc+='</table>';
      if(!oP) doc+='<p class="total">Valor disponible: $'+Math.round(totalValDisp)+'</p>';
      grandDisp+=totalValDisp;
    }
    if(estadoFil!=="disponibles"&&agotados.length){
      doc+='<h3><span class="badge sold">Agotados/Vendidos: '+agotados.length+' piezas</span></h3>';
      doc+='<table><tr><th>Clave</th><th>Descripcion</th>'+(oP?'':'<th>Precio venta</th>')+'<th>Costo prov.</th><th>Fecha ingreso</th></tr>';
      for(var ii=0;ii<agotados.length;ii++){ var it3=agotados[ii]; doc+='<tr style="color:#999"><td>'+esc(it3.sku)+'</td><td>'+esc(it3.descripcion)+'</td>'+(oP?'':'<td>$'+Math.round(it3.precioVenta)+'</td>')+'<td>$'+Math.round(it3.costoProveedor)+'</td><td>'+esc(it3.fechaIngreso||"")+'</td></tr>'; }
      doc+='</table>';
    }
    if(ventas.length){
      doc+='<h3>Ventas del periodo</h3><table><tr><th>Fecha</th><th>Clave</th><th>Descripcion</th>'+(oP?'':'<th>Precio</th><th>Total</th>')+'<th>Pago</th></tr>';
      for(var vi=0;vi<ventas.length;vi++){ var v=ventas[vi]; for(var li=0;li<v.lineas.length;li++){ var lv=v.lineas[li],itv=getItem(lv.itemId); if(!itv||itv.proveedorId!==p.id||lv.cancelada) continue; doc+='<tr><td>'+v.fecha+'</td><td><b>'+esc(itv.sku)+'</b></td><td>'+esc(itv.descripcion)+'</td>'+(oP?'':'<td>$'+Math.round(lv.precio)+'</td><td><b>$'+Math.round(lv.precio*lv.cantidad)+'</b></td>')+'<td>'+(v.mpago||"efectivo")+'</td></tr>'; } }
      doc+='</table><p class="total">Total ventas periodo: $'+Math.round(totalVentas)+'</p>';
      grandVentas+=totalVentas;
    } else { doc+='<p style="color:#999;font-size:11px;margin-bottom:12px">Sin ventas en el periodo.</p>'; }
  }
  // Si el reporte es de UN solo proveedor de consignacion, anexar leyenda de Clausula Segunda + fechas + firmas
  if(provsList.length===1 && provsList[0].tipo==="consignacion"){
    var pC=provsList[0];
    var nomC=(pC.nombreCompleto||"").trim()||pC.nombre;
    doc+='<div style="margin-top:18px;padding:10px 12px;background:#f9f6f0;border:1px solid #e5ddd0;border-radius:5px;font-size:10.5px;line-height:1.5;text-align:justify">Este reporte forma parte integrante del Contrato de Consignación celebrado entre '+esc(nomC)+' y Jardín de Hallazgos, conforme a su Cláusula Segunda. Al firmar de conformidad, ambas partes confirman que la mercancía aquí descrita fue entregada y recibida en las condiciones señaladas.<\/div>';
    doc+='<div style="margin-top:14px;font-size:11px">';
    if(pC.fechaContrato) doc+='<div>Contrato de consignación firmado el: <b>'+pC.fechaContrato+'<\/b><\/div>';
    else doc+='<div style="color:#b45309">Contrato de consignación <b>pendiente de firma<\/b><\/div>';
    doc+='<div>Fecha de impresión de este reporte: <b>'+hoy()+'<\/b><\/div><\/div>';
    doc+='<div style="margin-top:40px;display:flex;justify-content:space-between;gap:40px">';
    doc+='<div style="flex:1;text-align:center"><div style="border-top:1px solid #000;margin-top:36px;padding-top:5px;font-size:11px">EL PROVEEDOR<\/div><\/div>';
    doc+='<div style="flex:1;text-align:center"><div style="border-top:1px solid #000;margin-top:36px;padding-top:5px;font-size:11px">LA TIENDA (Jardín de Hallazgos)<\/div><\/div>';
    doc+='<\/div>';
  }
  doc+='<hr style="margin:20px 0;border-color:#ddd">';
  if(!oP) doc+='<p class="total">TOTAL VALOR INVENTARIO ACTIVO: $'+Math.round(grandDisp)+'</p>';
  doc+='<p class="total">TOTAL VENTAS PERIODO: $'+Math.round(grandVentas)+'</p>';
  doc+='<\/body><\/html>';
  CM();
  var w=window.open("","_blank","width=900,height=700");
  if(!w){alert("Permite ventanas emergentes.");return;}
  w.document.write(doc); w.document.close();
  w.onload=function(){ setTimeout(function(){ w.print(); },400); };
}

// ── LOGOTIPO ───────────────────────────────────────────────────────────────────
function applyConfig(){
  var logo=(DB.config&&DB.config.logo)||"";
  var fav=ge("favicon-link");
  var himg=ge("logo-img");
  if(logo){
    if(fav) fav.href=logo;
    if(himg){ himg.src=logo; himg.style.display="inline-block"; }
  } else {
    if(himg) himg.style.display="none";
  }
}
function aLogo(){
  var actual=(DB.config&&DB.config.logo)||"";
  var h='<div class="sm mut" style="margin-bottom:12px;line-height:1.6">Requisitos: solo formato PNG &middot; medida recomendada 512x512px cuadrada &middot; peso maximo 200 KB. El sistema comprime automaticamente la imagen al subirla.</div>';
  if(actual) h+='<div style="text-align:center;margin-bottom:12px"><img src="'+actual+'" style="width:80px;height:80px;border-radius:10px;object-fit:cover;border:1px solid #2a2620"/></div>';
  h+='<div class="fld"><input class="inp" type="file" id="logo-file" accept="image/png"/></div>';
  h+='<div id="logo-err" style="color:#f87171;font-size:12px;min-height:16px;margin-bottom:6px"></div>';
  h+='<div style="display:flex;justify-content:space-between;padding-top:7px">';
  h+='<button class="btnr" onclick="quitarLogo()">Quitar logotipo</button>';
  h+='<div style="display:flex;gap:8px"><button class="btn" onclick="CM()">Cancelar</button><button class="btna" onclick="guardarLogo()">Subir</button></div></div>';
  OM("Logotipo", h);
}
function quitarLogo(){
  if(!confirm("Quitar el logotipo actual?")) return;
  DB.config=DB.config||{}; DB.config.logo=""; dbSave(); applyConfig(); CM();
}
function guardarLogo(){
  var f=ge("logo-file"); var err=ge("logo-err");
  if(!f||!f.files||!f.files[0]){ if(err) err.textContent="Selecciona un archivo PNG."; return; }
  var file=f.files[0];
  if(file.type!=="image/png"){ if(err) err.textContent="Solo se aceptan archivos PNG."; return; }
  if(file.size>200*1024){ if(err) err.textContent="El archivo pesa mas de 200 KB. Usa una imagen mas ligera."; return; }
  var reader=new FileReader();
  reader.onload=function(e){
    var img=new Image();
    img.onload=function(){
      var size=256; // comprime a un cuadro estandar para mantener el sistema ligero
      var canvas=document.createElement("canvas");
      canvas.width=size; canvas.height=size;
      var ctx=canvas.getContext("2d");
      // recorte centrado cuadrado
      var side=Math.min(img.width,img.height);
      var sx=(img.width-side)/2, sy=(img.height-side)/2;
      ctx.drawImage(img,sx,sy,side,side,0,0,size,size);
      var dataUrl=canvas.toDataURL("image/png");
      DB.config=DB.config||{}; DB.config.logo=dataUrl; dbSave(); applyConfig(); CM();
      alert("Logotipo actualizado.");
    };
    img.onerror=function(){ if(err) err.textContent="No se pudo leer la imagen."; };
    img.src=e.target.result;
  };
  reader.onerror=function(){ if(err) err.textContent="No se pudo leer el archivo."; };
  reader.readAsDataURL(file);
}

// ── RESPALDO ───────────────────────────────────────────────────────────────────
function expCSV(){
  // Build rows sorted by provider name, then by sku
  var provName = {};
  for(var i=0;i<DB.provs.length;i++) provName[DB.provs[i].id] = DB.provs[i].nombre;
  var provTipo = {};
  for(var i=0;i<DB.provs.length;i++) provTipo[DB.provs[i].id] = DB.provs[i].tipo==="consignacion"?"Consignacion":"Compra directa";
  var items = DB.items.slice();
  items.sort(function(a,b){
    var pa = (provName[a.proveedorId]||"zzz").toLowerCase();
    var pb = (provName[b.proveedorId]||"zzz").toLowerCase();
    if(pa<pb) return -1;
    if(pa>pb) return 1;
    var sa = String(a.sku||"").toLowerCase();
    var sb = String(b.sku||"").toLowerCase();
    return sa<sb?-1:(sa>sb?1:0);
  });
  // CSV cell escaper: wrap in quotes if contains comma, quote or newline
  function cell(v){
    var s = String(v===null||v===undefined?"":v);
    if(s.indexOf('"')!==-1) s = s.replace(/"/g,'""');
    if(s.indexOf(",")!==-1 || s.indexOf('"')!==-1 || s.indexOf("\n")!==-1) s = '"'+s+'"';
    return s;
  }
  var rows = [];
  rows.push(["Proveedor","Tipo proveedor","Clave","Descripcion","Categoria","Epoca","Cantidad","Costo proveedor","Precio venta","Ganancia real","Fecha ingreso","Notas"].join(","));
  for(var i=0;i<items.length;i++){
    var it = items[i];
    var g = ganancia(it);
    rows.push([
      cell(provName[it.proveedorId]||"Sin proveedor"),
      cell(provTipo[it.proveedorId]||""),
      cell(it.sku),
      cell(it.descripcion),
      cell(it.categoria),
      cell(it.epoca),
      cell(it.cantidad||0),
      cell(Math.round((it.costoProveedor||0)*100)/100),
      cell(Math.round((it.precioVenta||0)*100)/100),
      cell(Math.round(g*100)/100),
      cell(it.fechaIngreso||""),
      cell(it.notas)
    ].join(","));
  }
  // BOM so Excel opens UTF-8 accents correctly
  var csv = "\ufeff" + rows.join("\r\n");
  var blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "arcana-inventario-"+hoy()+".csv";
  a.click();
  URL.revokeObjectURL(url);
  alert("Exportadas "+items.length+" prendas ordenadas por proveedor.");
}

function respaldar(){
  var f=hoy(),h2=new Date().toTimeString().slice(0,5).replace(":","h");
  var backup={version:3,exportado:f+" "+h2,items:DB.items,provs:DB.provs,ventas:DB.ventas,apartados:DB.apartados||[],saldos:DB.saldos||[],archivo:DB.archivo||[],config:DB.config||{}};
  // VERIFICACION DE COMPLETITUD: toda seccion de datos en DB debe estar en el respaldo.
  // Si en el futuro se agrega una seccion nueva a DB y no se incluye aqui, esta alerta lo detecta.
  var faltantes=[];
  for(var k in DB){
    if(!DB.hasOwnProperty(k)) continue;
    if(!(k in backup)) faltantes.push(k);
  }
  if(faltantes.length>0){
    alert("ATENCION: el respaldo NO incluye estas secciones de datos: "+faltantes.join(", ")+".\n\nEl respaldo se descargara de todos modos, pero avisa al desarrollador para corregirlo.");
  }
  var blob=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"});
  var url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url; a.download="arcana-respaldo-"+f+"-"+h2+".json"; a.click(); URL.revokeObjectURL(url);
  // Registrar cuando fue el ultimo respaldo, para el seguimiento en el checklist de cierre.
  try{ localStorage.setItem("ultimoRespaldo", hoy()); }catch(e){}
  var chk=ge("checklist-cierre"); if(chk) RChecklist();
}
function restaurar(){ ge("frest").click(); }

// ── INIT ────────────────────────────────────────────────────────────────────────
ge("mbg").addEventListener("click",function(e){ if(e.target===ge("mbg")) CM(); });
ge("ib").addEventListener("input",RI);
ge("pb").addEventListener("input",PR);
ge("epb-busq").addEventListener("input",function(){ epbRenderLista(this.value); });
ge("epb-cp").addEventListener("input",epbPrev);
ge("cdesc").addEventListener("input",calcC);
ge("chk-all").addEventListener("change",function(){
  var chks=document.querySelectorAll(".item-chk");
  for(var i=0;i<chks.length;i++) chks[i].checked=this.checked;
  updSel();
});
ge("frest").addEventListener("change",function(e){
  var file=e.target.files[0]; if(!file) return;
  var r=new FileReader();
  r.onload=function(ev){
    try{
      var d=JSON.parse(ev.target.result);
      if(!d.items||!d.provs) throw new Error();
      // Advertencia detallada: mostrar QUE se va a reemplazar y con QUE
      var apActuales=(DB.apartados||[]).length, apNuevos=(d.apartados||[]).length;
      var msg="Restaurar respaldo del "+d.exportado+"?\n\n";
      msg+="SE REEMPLAZARAN TODOS los datos actuales por los del respaldo:\n\n";
      msg+="Productos: "+(DB.items||[]).length+" actuales -> "+(d.items||[]).length+" del respaldo\n";
      msg+="Ventas: "+(DB.ventas||[]).length+" actuales -> "+(d.ventas||[]).length+" del respaldo\n";
      msg+="Apartados: "+apActuales+" actuales -> "+apNuevos+" del respaldo\n";
      if(apActuales>0 && apNuevos===0){
        msg+="\n*** ADVERTENCIA: tienes "+apActuales+" apartado(s) activo(s) que se PERDERAN, ";
        msg+="porque el respaldo no contiene apartados. ***\n";
      }
      msg+="\nEsta accion NO se puede deshacer. Continuar?";
      if(!confirm(msg)) return;
      DB={items:d.items,provs:d.provs,ventas:d.ventas||[],apartados:d.apartados||[],saldos:d.saldos||[],archivo:d.archivo||[],config:d.config||DB.config||{accessPass:ACCESS_PASS_DEFAULT,adminPass:ADMIN_PASS_DEFAULT,logo:""}};
      _itemIndex=null; _provIndex=null;
      dbSave(); RI(); applyConfig(); alert("Respaldo restaurado correctamente.");
    }catch(err){ alert("Archivo no valido."); }
  };
  r.readAsText(file); e.target.value="";
});

dbLoad();
ge("tab-pos").classList.add("on");
ge("btn-pos").classList.add("on");
var mbnPos=ge("mbn-pos"); if(mbnPos) mbnPos.classList.add("on");
PH(); RC();
