// ==UserScript==
// @name         Rodeo OB Process Totals Display (from FCLM)
// @namespace    http://tampermonkey.net/
// @version      4.10
// @description  FCLM OB rates bar on Rodeo ExSD, Flow Assist with Ship/Pick/Pack crew lists (Employee Time Detail links)
// @updateURL    https://axzile.corp.amazon.com/-/carthamus/download_script/rodeo-ob-process-totals-display-(from-fclm).user.js
// @downloadURL  https://axzile.corp.amazon.com/-/carthamus/download_script/rodeo-ob-process-totals-display-(from-fclm).user.js
// @match        https://rodeo-nrt.amazon.com/PER4/ExSD*
// @match        https://trans-logistics-fe.amazon.com/ssp/dock/hrz/ob*
// @match        https://fclm-portal.amazon.com/reports/functionRollup*
// @connect      fclm-portal.amazon.com
// @connect      atlas.qubit.amazon.dev
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    var SITE_CODE = 'PER4';
    var CREW_KEY = 'ob_crew_capture_v1';
    var CREW_STALE_MS = 90 * 60 * 1000; // 90 min
    var CREW_LOCAL_KEY = 'ob_crew_local_v1';
    var FCLM_BASE = 'https://fclm-portal.amazon.com/reports/processPathRollup';
    var ROLLUP_BASE = 'https://fclm-portal.amazon.com/reports/functionRollup';

    var FA_DEFAULTS = {
        apCpt:'17:30', dwtCpt:'04:00',
        unitsPerPkgAp:1.8, pkgsPerUld:65,
        unitsPerPkgDwt:2.1, pkgsPerKart:110,
        packHC:0, shipHC:0, shipRate:0,
        activeTab:'ship', activeTool:'containers',
        crewShipId:'01720696420654',
        crewPickId:'',
        crewPackId:'',
    };
    var FA_KEY = 'ob_flow_assist_settings';
    var SSP_CACHE_KEY = 'ssp_cache_v1';
    var SSP_STALE_MS  = 6 * 60 * 1000;
    var SECTIONS = [
        {key:'pick',label:'Pick - Total',col0:true},
        {key:'packSingles',label:'Pack Singles - Total',col0:true},
        {key:'packMultis',label:'Pack Multis - Total',col0:true},
        {key:'obTotal',label:'OB TOTAL',col0:false},
    ];
    var FA_TOOLS = [
        {id:'containers',name:'Container Calculation (ULDs & Go-Karts)',ready:true},
        {id:'ssp',name:'SSP — closest truck departure',ready:true},
        {id:'atlas',name:'ATLAS — Ship quality defects by quarter',ready:true},
    ];

    function readSspCache(){try{return JSON.parse(GM_getValue(SSP_CACHE_KEY,'null'));}catch(e){return null;}}
    function saveSspCache(fn){var c=readSspCache()||{};fn(c);c.updatedAt=Date.now();GM_setValue(SSP_CACHE_KEY,JSON.stringify(c));}

    if (location.hostname==='trans-logistics-fe.amazon.com'){installSspCompanion();return;}
    if (location.hostname==='fclm-portal.amazon.com'){installCrewCapture();return;}

    var lastPackAvg = NaN;

    function loadS(){try{var r=localStorage.getItem(FA_KEY);var s=r?JSON.parse(r):{};var o={};for(var k in FA_DEFAULTS)o[k]=(s[k]!==undefined)?s[k]:FA_DEFAULTS[k];return o;}catch(e){return Object.assign({},FA_DEFAULTS);}}
    function saveS(s){try{localStorage.setItem(FA_KEY,JSON.stringify(s));}catch(e){}}

    // Perth time helper
    function perthDate(){var n=new Date(),u=n.getTime()+n.getTimezoneOffset()*60000;return new Date(u+8*3600000);}

    function buildFclmUrl(){
        var p=perthDate();
        var dateStr=p.getFullYear()+'%2F'+String(p.getMonth()+1).padStart(2,'0')+'%2F'+String(p.getDate()).padStart(2,'0');
        return FCLM_BASE+'?reportFormat=HTML&warehouseId='+encodeURIComponent(SITE_CODE)+'&maxIntradayDays=1&spanType=Intraday&startDateIntraday='+dateStr+'&startHourIntraday=8&startMinuteIntraday=0&endDateIntraday='+dateStr+'&endHourIntraday=18&endMinuteIntraday=0&_adjustPlanHours=on&_hideEmptyLineItems=on&rememberViewForWarehouse=true&_rememberViewForWarehouse=on&employmentType=AllEmployees&pprCustomViewName=OB_Shift&privateView=true';
    }

    function buildCrewUrl(pid){
        var p=perthDate();
        var today=p.getFullYear()+'-'+String(p.getMonth()+1).padStart(2,'0')+'-'+String(p.getDate()).padStart(2,'0');
        return ROLLUP_BASE+'?warehouseId='+encodeURIComponent(SITE_CODE)+'&spanType=Intraday&startDate='+encodeURIComponent(today+'T08:00:00.000')+'&endDate='+encodeURIComponent(today+'T18:00:00.000')+'&reportFormat=HTML&processId='+encodeURIComponent(pid);
    }

    // ─── Utilities ───
    function norm(s){return s.replace(/[\u2013\u2014\u2010\u2011\u2012]/g,'-').replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim().toLowerCase();}
    function looseEq(a,b){var s=function(x){return norm(x).replace(/[^a-z0-9]/g,'');};return s(a)===s(b);}
    function parseN(s){if(!s)return NaN;return parseFloat(s.replace(/[^0-9.\-]/g,''));}
    function fmtR(n){return isNaN(n)?'—':n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});}
    function fmtI(n){return isNaN(n)?'—':Math.ceil(n).toLocaleString();}

    // ─── Styles ───
    GM_addStyle(`
        #ob-bar{display:flex!important;align-items:stretch!important;justify-content:space-between!important;background:#006064!important;border-bottom:3px solid #00838f!important;padding:0!important;margin:0!important;font-family:'Segoe UI',system-ui,sans-serif!important;width:100%!important;min-height:54px!important;box-sizing:border-box!important;position:relative!important;z-index:999!important;}
        .ob-cell{flex:1!important;display:flex!important;flex-direction:column!important;justify-content:center!important;padding:8px 16px!important;border-right:1px solid rgba(255,255,255,0.15)!important;min-width:0!important;}
        .ob-cell:last-child{border-right:none!important;}
        .ob-cell-title{font-size:10px!important;font-weight:700!important;color:rgba(255,255,255,0.6)!important;text-transform:uppercase!important;letter-spacing:0.8px!important;margin-bottom:2px!important;white-space:nowrap!important;}
        .ob-cell-row{display:flex!important;align-items:baseline!important;gap:10px!important;}
        .ob-vol{font-size:20px!important;font-weight:700!important;color:#fff!important;line-height:1.1!important;}
        .ob-rate{font-size:13px!important;font-weight:600!important;color:#b2ebf2!important;}
        .ob-cell.rate-cell{background:rgba(0,0,0,0.15)!important;}
        .ob-rate-big{font-size:20px!important;font-weight:700!important;color:#ffeb3b!important;line-height:1.1!important;}
        .ob-notfound{font-size:11px!important;color:rgba(255,255,255,0.35)!important;font-style:italic!important;}
        .ob-status{font-size:11px!important;color:rgba(255,255,255,0.5)!important;font-style:italic!important;padding:14px 20px!important;}
        .ob-cell.fa-btn-cell{flex:0 0 auto!important;cursor:pointer!important;background:rgba(255,255,255,0.08)!important;align-items:center!important;user-select:none!important;}
        .ob-cell.fa-btn-cell:hover{background:rgba(255,255,255,0.18)!important;}
        .fa-btn-label{font-size:13px!important;font-weight:700!important;color:#fff!important;white-space:nowrap!important;}
        #fa-panel{display:none;background:#004d51!important;border-bottom:3px solid #00838f!important;font-family:'Segoe UI',system-ui,sans-serif!important;padding:12px 16px!important;box-sizing:border-box!important;position:relative!important;z-index:998!important;color:#fff!important;}
        #fa-panel.open{display:flex!important;flex-direction:column!important;}
        .fa-section{flex:1!important;min-width:260px!important;background:rgba(0,0,0,0.15)!important;border-radius:6px!important;padding:10px 14px!important;}
        .fa-section-title{font-size:11px!important;font-weight:700!important;color:#b2ebf2!important;text-transform:uppercase!important;letter-spacing:0.8px!important;margin-bottom:8px!important;}
        .fa-row{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:10px!important;margin-bottom:4px!important;font-size:12px!important;}
        .fa-row-label{color:rgba(255,255,255,0.7)!important;}
        .fa-row-value{font-weight:700!important;color:#fff!important;font-size:14px!important;}
        .fa-big{font-size:22px!important;font-weight:700!important;color:#ffeb3b!important;}
        .fa-input{width:64px!important;padding:2px 6px!important;border:1px solid rgba(255,255,255,0.3)!important;border-radius:4px!important;background:rgba(255,255,255,0.1)!important;color:#fff!important;font-size:12px!important;text-align:right!important;}
        .fa-hc-more{color:#ef9a9a!important;} .fa-hc-less{color:#a5d6a7!important;} .fa-hc-ok{color:#fff!important;}
        .fa-note{font-size:10px!important;color:rgba(255,255,255,0.4)!important;margin-top:6px!important;font-style:italic!important;}
        .fa-tabs{display:flex!important;gap:6px!important;margin-bottom:10px!important;}
        .fa-tab{padding:6px 18px!important;border-radius:4px 4px 0 0!important;background:rgba(255,255,255,0.08)!important;color:rgba(255,255,255,0.6)!important;font-size:12px!important;font-weight:700!important;cursor:pointer!important;user-select:none!important;text-transform:uppercase!important;letter-spacing:0.5px!important;}
        .fa-tab:hover{background:rgba(255,255,255,0.18)!important;}
        .fa-tab.active{background:rgba(0,0,0,0.25)!important;color:#ffeb3b!important;}
        .fa-tab-body{display:flex!important;gap:24px!important;flex-wrap:wrap!important;align-items:flex-start!important;}
        .fa-select{width:100%!important;padding:6px 8px!important;border:1px solid rgba(255,255,255,0.3)!important;border-radius:4px!important;background:#00363a!important;color:#fff!important;font-size:12px!important;}
        .fa-tool-display{flex:2!important;display:flex!important;gap:16px!important;flex-wrap:wrap!important;min-width:300px!important;}
        .fa-tool-display .fa-section{min-width:240px!important;}
        .fa-placeholder{flex:1!important;padding:20px!important;font-size:12px!important;color:rgba(255,255,255,0.4)!important;font-style:italic!important;background:rgba(0,0,0,0.15)!important;border-radius:6px!important;}
        .atlas-table{width:100%!important;border-collapse:collapse!important;margin:8px 0!important;font-size:11px!important;}
        .atlas-table th{text-align:left!important;color:#b2ebf2!important;font-weight:700!important;padding:3px 8px!important;border-bottom:1px solid rgba(255,255,255,0.25)!important;}
        .atlas-table td{color:#fff!important;padding:3px 8px!important;border-bottom:1px solid rgba(255,255,255,0.08)!important;}
        .crew-tbl{width:100%!important;border-collapse:collapse!important;margin-top:4px!important;}
        .crew-tbl th{text-align:left!important;padding:4px 8px!important;font-size:10px!important;font-weight:600!important;letter-spacing:.4px!important;text-transform:uppercase!important;color:rgba(255,255,255,0.45)!important;border-bottom:1px solid rgba(255,255,255,0.2)!important;}
        .crew-tbl td{color:#fff!important;padding:4px 8px!important;border-bottom:1px solid rgba(255,255,255,0.08)!important;font-size:12px!important;vertical-align:middle!important;}
        .crew-tbl tr:last-child td{border-bottom:none!important;}
        .crew-wrap{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;}
        .crew-block{flex:1;min-width:220px;background:rgba(0,0,0,0.15);border-radius:6px;padding:10px 14px;}
        .crew-head{font-size:11px;font-weight:700;color:#b2ebf2;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;}
        .crew-refresh{cursor:pointer;color:#b2ebf2;font-size:14px;padding:0 4px;}
        .crew-paste-zone::placeholder{color:rgba(255,255,255,0.45);font-style:italic;}
        .crew-pid-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;}
        .crew-pid-row label{font-size:10px;color:rgba(255,255,255,0.5);white-space:nowrap;}
        .crew-pid{flex:1;padding:3px 6px;border:1px solid rgba(255,255,255,0.25);border-radius:4px;background:rgba(255,255,255,0.08);color:#fff;font-size:10px;font-family:monospace;}
        .crew-link{color:#60a5fa!important;font-family:monospace;text-decoration:none;border-bottom:1px dotted #60a5fa;}
        .crew-link:hover{color:#93c5fd!important;}
        .crew-count{font-size:10px;color:rgba(255,255,255,0.4);}
    `);

    // ─── Parse processPathRollup ───
    function extractFromHTML(html){
        var doc=new DOMParser().parseFromString(html,'text/html');
        var tables=doc.querySelectorAll('table');
        if(!tables.length) return null;
        var found={},n=0;
        for(var t=0;t<tables.length;t++){
            for(var r=0;r<tables[t].rows.length;r++){
                var row=tables[t].rows[r];
                if(row.cells.length<5) continue;
                for(var i=0;i<SECTIONS.length;i++){
                    var s=SECTIONS[i];
                    if(!s.col0||found[s.key]) continue;
                    if(norm(row.cells[0].textContent.trim())===norm(s.label)){
                        found[s.key]={vol:row.cells[2].textContent.trim(),rate:row.cells[4].textContent.trim()};
                        n++;
                    }
                }
            }
        }
        var ob=findObTotal(tables); if(ob){found.obTotal=ob;n++;}
        return n>0?found:null;
    }
    function findObTotal(tables){
        for(var t=0;t<tables.length;t++){
            for(var r=0;r<tables[t].rows.length;r++){
                var cells=tables[t].rows[r].cells; if(!cells||!cells.length) continue;
                var li=-1;
                for(var c=0;c<cells.length;c++){
                    var tx=norm(cells[c].textContent.trim());
                    if(looseEq(tx,'OB TOTAL')){li=c;break;}
                    if(tx==='total'&&c+1<cells.length&&looseEq(cells[c+1].textContent.trim(),'OB')){li=c+1;break;}
                }
                if(li===-1) continue;
                var vi=li+2,ri=li+4;
                if(ri<cells.length) return{vol:cells[vi].textContent.trim(),rate:cells[ri].textContent.trim()};
            }
        }
        return null;
    }

    // ─── Crew: parse functionRollup HTML ───
    // ─── Crew capture: shared GM storage, written on the FCLM page, read on Rodeo ───

    function readCrewLocal(){
        var raw=localStorage.getItem(CREW_LOCAL_KEY);
        if(!raw) return {};
        var store=JSON.parse(raw);
        if(!store||typeof store!=='object'||Array.isArray(store))
            throw new Error('Saved crew data is invalid.');
        return store;
    }
    function writeCrewLocal(pid,ts,emps){
        var store=readCrewLocal();
        store[pid]={ts:ts,emps:emps};
        localStorage.setItem(CREW_LOCAL_KEY,JSON.stringify(store));
    }

    function readCrewStore(){try{return JSON.parse(GM_getValue(CREW_KEY,'{}'))||{};}catch(e){return {};}}
    function writeCrewCapture(pid,emps){
        var store=readCrewStore();
        store[pid]={ts:Date.now(),emps:emps};
        GM_setValue(CREW_KEY,JSON.stringify(store));
    }

    // Report continuation rows can put hours in Name and units in Login.
    // Check the name, not ID length: real Pick employees may have only numeric IDs.
    function isCrewEmployeeName(name){
        return typeof name==='string'&&/\p{L}/u.test(name)&&name.trim().toLowerCase()!=='total';
    }
    function filterCrewEmployees(emps){
        return emps.filter(function(e){return e&&isCrewEmployeeName(e.name);});
    }

    function parseCrewHTML(html){
        var doc=new DOMParser().parseFromString(html,'text/html');
        var tables=doc.querySelectorAll('table');
        var emps=[],seen={};
        for(var t=0;t<tables.length;t++){
            var rows=tables[t].querySelectorAll('tr');
            var li=-1,ni=-1,ii=-1,hdr=null;
            for(var r=0;r<rows.length;r++){
                var cells=rows[r].querySelectorAll('th,td');
                var tx=Array.prototype.slice.call(cells).map(function(c){return c.textContent.trim().toLowerCase();});
                var la=tx.indexOf('login');
                var na=-1;for(var x=0;x<tx.length;x++)if(tx[x]==='name'){na=x;break;}
                var ia=-1;for(var y=0;y<tx.length;y++)if(tx[y]==='id'){ia=y;break;}
                if(na>=0&&(la>=0||ia>=0)){li=la;ni=na;ii=ia;hdr=rows[r];break;}
            }
            if(!hdr) continue;
            for(var dr=0;dr<rows.length;dr++){
                if(rows[dr]===hdr) continue;
                var dc=rows[dr].querySelectorAll('td');
                if(dc.length<=ni||Array.prototype.some.call(dc,function(c){return c.colSpan>1;})) continue;
                // Summary/"Total" rows often use a colspan on the first cell, which shifts every
                // later column index — catch it by its own text before trusting dc[li]/dc[ni].
                var firstTxt=dc[0]?dc[0].textContent.trim().toLowerCase():'';
                if(firstTxt==='total'||firstTxt.indexOf('total')===0) continue;
                var login=li>=0&&dc[li]?dc[li].textContent.trim():'';
                var name=dc[ni]?dc[ni].textContent.trim():'';
                // Pick reports may omit Login; require a name and a login or numeric ID.
                if(!isCrewEmployeeName(name)) continue;
                if(login.toLowerCase()==='login'||login.toLowerCase()==='total') continue;
                if(name.toLowerCase()==='total') continue;
                // Only the bare numeric employeeId travels through the clipboard (not the
                // full timeDetails URL), keeping the clipboard payload compact. The link
                // itself is rebuilt locally on the Rodeo side with today's date (see empIdUrl()).
                var empId=null;
                if(ii>=0&&dc[ii]){
                    var a=dc[ii].querySelector('a');
                    if(a){var h=a.getAttribute('href')||'';
                        var m=h.match(/employeeId=(\d+)/);
                        if(m) empId=m[1];
                    }
                }
                if(!empId&&ii>=0&&dc[ii]){
                    var idText=dc[ii].textContent.trim();
                    if(/^\d+$/.test(idText)) empId=idText;
                }
                if(!login&&!empId) continue;
                var identity=empId?'id:'+empId:'login:'+login;
                if(seen[identity]) continue;
                seen[identity]=true;
                emps.push({name:name,login:login,empId:empId});
            }
        }
        return emps;
    }

    // Fetch crew for one block and render into contentId div
    // Rebuilds the FCLM employee Time Details link from just the bare employeeId, using
    // today's date — avoids ever putting a full amazon.com URL through the clipboard.
    function empIdUrl(empId){
        var d=new Date();
        var ds=d.getFullYear()+'%2f'+String(d.getMonth()+1).padStart(2,'0')+'%2f'+String(d.getDate()).padStart(2,'0');
        return 'https://fclm-portal.amazon.com/employee/timeDetails?employeeId='+empId+'&warehouseId='+SITE_CODE+
            '&spanType=Intraday&startDateIntraday='+ds+'&endDateIntraday='+ds+
            '&startHourIntraday=8&startMinuteIntraday=0&endHourIntraday=18&endMinuteIntraday=0';
    }

    function renderCrewRows(emps){
        emps=filterCrewEmployees(emps);
        var rows='';
        for(var i=0;i<emps.length;i++){
            var e=emps[i];
            var label=e.login||e.empId||'';
            var lc=e.empId?'<a class="crew-link" href="'+empIdUrl(e.empId)+'" target="_blank" title="Employee Time Details">'+label+'</a>'
                      :(e.url?'<a class="crew-link" href="'+e.url+'" target="_blank" title="Employee Time Details">'+label+'</a>'
                      :'<span style="color:#60a5fa;font-family:monospace">'+label+'</span>');
            rows+='<tr><td>'+e.name+'</td><td>'+lc+'</td></tr>';
        }
        return '<table class="crew-tbl"><thead><tr><th>Name</th><th>Login / ID</th></tr></thead><tbody>'+rows+'</tbody></table>';
    }

    function crewAgo(ms){
        var m=Math.round((Date.now()-ms)/60000);
        return m<1?'just now':m<60?m+'m ago':Math.round(m/60)+'h ago';
    }

    // Crew data now comes from a capture run on the FCLM page itself (see installCrewCapture),
    // shared via GM storage — no cross-origin request from Rodeo, which was getting blocked/redirected.
    function loadCrew(contentId,pid){
        var box=document.getElementById(contentId); if(!box) return;
        var visitUrl=buildCrewUrl(pid);
        if(!pid){box.innerHTML='<div class="fa-note">Paste a processId above, then click ⟳</div>';return;}
        var local=readCrewLocal(); var gm=readCrewStore();
        var capL=local[pid], capG=gm[pid];
        var cap=(capL&&capG)?(capL.ts>=capG.ts?capL:capG):(capL||capG);
        var visitLink='<a href="'+visitUrl+'" target="_blank" style="color:#b2ebf2">Visit FCLM to capture ↗</a>';
        if(!cap||!cap.emps||!cap.emps.length){
            box.innerHTML='<div class="fa-note">No capture for '+pid+' yet. '+visitLink+
                ', then right-click → Paste into the capture box above.</div>';
            return;
        }
        var emps=filterCrewEmployees(cap.emps);
        var stale=(Date.now()-cap.ts)>CREW_STALE_MS;
        var staleNote=stale?' &middot; <span style="color:#ffab91">stale, '+visitLink+'</span>':'';
        box.innerHTML='<span class="crew-count">'+emps.length+' employees &middot; captured '+crewAgo(cap.ts)+staleNote+'</span>'+
            renderCrewRows(emps);
    }

    // Accept the full capture envelope or a bare employee array.
    function normalizeCrewPaste(text,fallbackPid){
        var payload=JSON.parse(text.trim());
        if(Array.isArray(payload)) payload={pid:fallbackPid,emps:payload};
        if(!payload||typeof payload!=='object') throw new Error('Expected a capture object or employee list.');
        var pid=String(payload.pid||fallbackPid||'').trim();
        if(!/^\d+$/.test(pid)) throw new Error('Enter the processId above before importing an employee list.');
        if(!Array.isArray(payload.emps)||!payload.emps.length) throw new Error('The capture has no employee list.');
        if(!payload.emps.every(function(e){return e&&typeof e.name==='string'&&e.name.trim()&&((typeof e.login==='string'&&e.login.trim())||(typeof e.empId==='string'&&/^\d+$/.test(e.empId))); }))
            throw new Error('Each employee needs a name and a login or numeric employee ID.');
        var emps=filterCrewEmployees(payload.emps);
        if(!emps.length) throw new Error('The capture contains no employee names. Capture the employee table again.');
        return {pid:pid,ts:typeof payload.ts==='number'&&isFinite(payload.ts)&&payload.ts>0?payload.ts:Date.now(),emps:emps};
    }

    function applyCrewPaste(contentId,pkey,text){
        var b=document.getElementById(contentId); if(!b) return false;
        var inp=document.getElementById('pid-'+contentId);
        var payload;
        try{payload=normalizeCrewPaste(text,inp?inp.value:'');}
        catch(e){
            b.textContent='Capture not imported: '+e.message+' Paste the complete JSON, including its opening and closing brackets.';
            return false;
        }
        try{
            writeCrewLocal(payload.pid,payload.ts,payload.emps);
            var curr=loadS(); curr[pkey]=payload.pid; saveS(curr);
            if(inp) inp.value=payload.pid;
            loadCrew(contentId,payload.pid);
            return true;
        }catch(e){
            b.textContent='Capture could not be saved or displayed: '+e.message;
            return false;
        }
    }

    // Runs on the FCLM functionRollup page itself: parse the crew table already in the DOM
    // and store it under this page's processId so the Rodeo page can read it.
    function installCrewCapture(){
        var lastCapture='', scanning=false;
        function go(){
            if(scanning) return;
            scanning=true;
            try{
                var qs=new URLSearchParams(location.search);
                var pid=qs.get('processId');
                if(!pid) return;
                var emps=parseCrewHTML(document.documentElement.outerHTML);
                if(!emps.length) return;
                var signature=JSON.stringify({pid:pid,emps:emps});
                if(signature===lastCapture) return;
                writeCrewCapture(pid,emps);
                lastCapture=signature;
                var payload=JSON.stringify({pid:pid,ts:Date.now(),emps:emps});
                try{GM_setClipboard(payload);}catch(e){}
                var note=document.createElement('div');
                var dbg=emps.map(function(e){return (e.login||'?')+(e.name?' ['+e.name+']':' [no-name]');}).join(', ');
                note.textContent='✅ Captured '+emps.length+' employees, copied to clipboard. On Rodeo, right-click → Paste into the matching crew block. (processId '+pid+'): '+dbg;
                note.style.cssText='position:fixed;bottom:16px;right:16px;max-width:520px;background:#006064;color:#fff;padding:10px 16px;border-radius:6px;font-family:sans-serif;font-size:12px;line-height:1.4;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,0.4)';
                document.body.appendChild(note);
                setTimeout(function(){note.remove();},15000);
            }catch(e){console.error('Crew capture failed:',e);}
            finally{scanning=false;}
        }
        setTimeout(go,1200);
        var obs=new MutationObserver(function(){clearTimeout(window.__crewCapT);window.__crewCapT=setTimeout(go,1200);});
        obs.observe(document.body,{childList:true,subtree:true});
    }

    // Build one crew block HTML
    function crewBlockHTML(emoji,label,pidKey,contentId,pid){
        return '<div class="crew-block">'+
            '<div class="crew-head">'+emoji+' '+label+' Crew'+
                '<span class="crew-refresh" data-cid="'+contentId+'" data-pkey="'+pidKey+'" title="Refresh">⟳</span>'+
            '</div>'+
            '<div class="crew-pid-row"><label>processId</label>'+
                '<input class="crew-pid" id="pid-'+contentId+'" data-pkey="'+pidKey+'" type="text" '+
                    'placeholder="paste from functionRollup URL" value="'+pid+'">'+
            '</div>'+
            '<div class="crew-pid-row"><label>capture</label>'+
                '<input class="crew-pid crew-paste-zone" id="paste-'+contentId+'" data-cid="'+contentId+'" data-pkey="'+pidKey+'" type="text" '+
                    'placeholder="📋 click here, right-click → Paste the FCLM capture" value="">'+
            '</div>'+
            '<div id="'+contentId+'"><div class="fa-note">'+
                (pid?'Click ⟳ to load, or paste a fresh capture above.':'Paste the processId from the FCLM functionRollup URL, then click ⟳')+
            '</div></div>'+
        '</div>';
    }

    function crewSectionHTML(s){
        return '<div class="crew-wrap">'+
            crewBlockHTML('🔵','Ship','crewShipId','crew-ship',s.crewShipId)+
            crewBlockHTML('🟢','Pick','crewPickId','crew-pick',s.crewPickId)+
            crewBlockHTML('🟠','Pack','crewPackId','crew-pack',s.crewPackId)+
        '</div>';
    }

    // Accept a raw processId or a pasted functionRollup/processPathRollup URL and pull the processId out of it.
    function extractPid(raw){
        var v=(raw||'').trim();
        if(!v) return '';
        if(v.indexOf('processId=')>=0){
            try{
                var qs=v.indexOf('?')>=0?v.slice(v.indexOf('?')):('?'+v.split('processId=')[1]);
                var m=new URLSearchParams(qs.indexOf('?')===0?qs.slice(1):qs);
                var p=m.get('processId');
                if(p) return decodeURIComponent(p);
            }catch(e){
                var m2=v.match(/processId=([^&]+)/);
                if(m2) return decodeURIComponent(m2[1]);
            }
        }
        return v;
    }

    function wireCrewBlocks(){
        var btns=document.querySelectorAll('.crew-refresh');
        for(var i=0;i<btns.length;i++){(function(btn){
            btn.addEventListener('click',function(){
                var pkey=btn.getAttribute('data-pkey');
                var cid=btn.getAttribute('data-cid');
                var inp=document.getElementById('pid-'+cid);
                var raw=inp?inp.value.trim():'';
                var pid=extractPid(raw);
                if(inp&&pid!==raw) inp.value=pid;
                var curr=loadS(); curr[pkey]=pid; saveS(curr);
                loadCrew(cid,pid);
            });
        })(btns[i]);}
        var pasteZones=document.querySelectorAll('.crew-paste-zone');
        for(var j=0;j<pasteZones.length;j++){(function(zone){
            function flash(ok){
                zone.style.transition='none';
                zone.style.background=ok?'#1b5e20':'#5d1a1a';
                setTimeout(function(){zone.style.transition='background 0.6s';zone.style.background='';},600);
            }
            function handle(text){
                var pkey=zone.getAttribute('data-pkey');
                var cid=zone.getAttribute('data-cid');
                zone.value=text;
                var ok=applyCrewPaste(cid,pkey,text);
                flash(ok);
                if(ok) zone.value='';
            }
            // Primary path: native paste event (works even without any Clipboard-API permission).
            zone.addEventListener('paste',function(e){
                e.preventDefault();
                var text=(e.clipboardData||window.clipboardData).getData('text');
                handle(text);
            });
            // Fallback: some corporate DLP/clipboard policies swallow the 'paste' event but still
            // let the OS insert the text into the field. Catch that via plain input changes too.
            zone.addEventListener('input',function(){
                var v=zone.value;
                if(v && /^[\[{]/.test(v.trim())) {
                    try{JSON.parse(v);}catch(e){return;}
                    handle(v);
                }
            });
        })(pasteZones[j]);}
    }

    function autoLoadCrew(s){
        var blocks=[
            {cid:'crew-ship',pkey:'crewShipId'},
            {cid:'crew-pick',pkey:'crewPickId'},
            {cid:'crew-pack',pkey:'crewPackId'},
        ];
        for(var i=0;i<blocks.length;i++){
            var raw=s[blocks[i].pkey];
            var pid=extractPid(raw);
            if(pid&&pid!==raw){
                var curr=loadS(); curr[blocks[i].pkey]=pid; saveS(curr);
                var inp=document.getElementById('pid-'+blocks[i].cid);
                if(inp) inp.value=pid;
            }
            if(pid&&document.getElementById(blocks[i].cid)){
                try{loadCrew(blocks[i].cid,pid);}catch(e){document.getElementById(blocks[i].cid).textContent='Could not load saved crew: '+e.message;}
            }
        }
    }

    // ═══════════════ FLOW ASSIST ═══════════════

    var FA_COUNT_ROWS=['PredictedCharge','Picking Subtotal','WorkInProgress Subtotal'];
    var FA_SHIP_ROW='Shipping Subtotal';

    function isTC(txt){return/(^|\s)\d{1,2}:\d{2}$/.test(txt);}
    function lsw(label,want){var s=function(x){return norm(x).replace(/[^a-z0-9]/g,'');};return s(label).indexOf(s(want))===0;}

    function getRodeoCpt(cptTime){
        var allRows=[],tables=document.querySelectorAll('table');
        for(var t=0;t<tables.length;t++){
            if(tables[t].closest('#ob-bar')||tables[t].closest('#fa-panel')) continue;
            for(var r=0;r<tables[t].rows.length;r++) allRows.push(tables[t].rows[r]);
        }
        var hdr=null,best=1;
        for(var a=0;a<allRows.length;a++){var cnt=0;for(var c=0;c<allRows[a].cells.length;c++)if(isTC(allRows[a].cells[c].textContent.replace(/\s+/g,' ').trim()))cnt++;if(cnt>best){best=cnt;hdr=allRows[a];}}
        if(!hdr) return{units:NaN,shipped:NaN};
        var tc=[],H=hdr.cells.length;
        for(var hc=0;hc<H;hc++){var ht=hdr.cells[hc].textContent.replace(/\s+/g,' ').trim();if(isTC(ht))tc.push({text:ht,fe:H-hc});}
        var rm={},want=FA_COUNT_ROWS.concat([FA_SHIP_ROW]);
        for(var b=0;b<allRows.length;b++){if(!allRows[b].cells.length)continue;var lbl=allRows[b].cells[0].textContent.trim();for(var w=0;w<want.length;w++)if(!rm[want[w]]&&lsw(lbl,want[w])&&allRows[b].cells.length>tc.length)rm[want[w]]=allRows[b];}
        function va(row,col){if(!row)return 0;var i=row.cells.length-col.fe;if(i<0||i>=row.cells.length)return 0;var v=parseN(row.cells[i].textContent.trim());return isNaN(v)?0:v;}
        var cands=tc.filter(function(x){return x.text===cptTime||x.text.endsWith(' '+cptTime);});
        if(!cands.length) return{units:NaN,shipped:NaN};
        var chosen=cands[0];
        for(var k=0;k<cands.length;k++){var sum=0;for(var fr=0;fr<FA_COUNT_ROWS.length;fr++)sum+=va(rm[FA_COUNT_ROWS[fr]],cands[k]);if(sum>0){chosen=cands[k];break;}}
        var units=0;for(var p=0;p<FA_COUNT_ROWS.length;p++)units+=va(rm[FA_COUNT_ROWS[p]],chosen);
        return{units:units,shipped:va(rm[FA_SHIP_ROW],chosen)};
    }

    function shipHcHTML(s){
        var pt=(!isNaN(lastPackAvg)&&s.packHC>0)?lastPackAvg*s.packHC:NaN;
        var sn=(!isNaN(pt)&&s.shipRate>0)?Math.ceil(pt/s.shipRate):NaN;
        var sd=(!isNaN(sn)&&s.shipHC>0)?sn-s.shipHC:NaN;
        var dt,dc;
        if(isNaN(sd)){dt='—';dc='fa-hc-ok';}else if(sd>0){dt='Need '+sd+' more';dc='fa-hc-more';}else if(sd<0){dt='Can release '+(-sd);dc='fa-hc-less';}else{dt='Right-sized';dc='fa-hc-ok';}
        return '<div class="fa-section" style="flex:1;min-width:240px;">'+
            '<div class="fa-section-title">Ship — Headcount</div>'+
            '<div class="fa-row"><span class="fa-row-label">Pack avg rate (FCLM)</span><span class="fa-row-value">'+fmtR(lastPackAvg)+'</span></div>'+
            '<div class="fa-row"><span class="fa-row-label">HC in Pack</span><input class="fa-input" data-fa-key="packHC" type="number" min="0" value="'+s.packHC+'"></div>'+
            '<div class="fa-row"><span class="fa-row-label">Pack throughput (u/hr)</span><span class="fa-row-value">'+fmtI((!isNaN(lastPackAvg)&&s.packHC>0)?lastPackAvg*s.packHC:NaN)+'</span></div>'+
            '<div class="fa-row"><span class="fa-row-label">Ship rate per HC</span><input class="fa-input" data-fa-key="shipRate" type="number" min="0" value="'+s.shipRate+'"></div>'+
            '<div class="fa-row"><span class="fa-row-label">Ship HC now</span><input class="fa-input" data-fa-key="shipHC" type="number" min="0" value="'+s.shipHC+'"></div>'+
            '<div class="fa-row"><span class="fa-row-label">Ship HC needed</span><span class="fa-big">'+(isNaN(sn)?'—':sn)+'</span></div>'+
            '<div class="fa-row"><span class="fa-row-label">Adjustment</span><span class="fa-row-value '+dc+'">'+dt+'</span></div>'+
            '<div class="fa-note">Inputs saved automatically.</div></div>';
    }

    function toolPickHTML(s){
        var opts='';
        for(var i=0;i<FA_TOOLS.length;i++){var tl=FA_TOOLS[i];opts+='<option value="'+tl.id+'"'+(s.activeTool===tl.id?' selected':'')+'>'+tl.name+'</option>';}
        return '<div class="fa-section" style="flex:1;min-width:220px;"><div class="fa-section-title">Tools</div><select id="fa-tool-select" class="fa-select">'+opts+'</select><div class="fa-note">Pick a tool.</div></div>';
    }

    function containerHTML(s){
        var ap=getRodeoCpt(s.apCpt),apP=ap.units/s.unitsPerPkgAp,ulds=Math.ceil(apP/s.pkgsPerUld),sUld=Math.ceil(ap.shipped/s.unitsPerPkgAp/s.pkgsPerUld);
        var dw=getRodeoCpt(s.dwtCpt),dwP=dw.units/s.unitsPerPkgDwt,kts=Math.ceil(dwP/s.pkgsPerKart),sKt=Math.ceil(dw.shipped/s.unitsPerPkgDwt/s.pkgsPerKart);
        return '<div class="fa-section"><div class="fa-section-title">AP — ULDs</div>'+
            '<div class="fa-row"><span class="fa-row-label">CPT</span><input class="fa-input" data-fa-key="apCpt" type="text" value="'+s.apCpt+'"></div>'+
            '<div class="fa-row"><span class="fa-row-label">Units to flow</span><span class="fa-row-value">'+(isNaN(ap.units)?'—':ap.units.toLocaleString())+'</span></div>'+
            '<div class="fa-row"><span class="fa-row-label">In Ship Dock</span><span class="fa-row-value">'+(isNaN(ap.shipped)?'—':'~'+sUld+' ULDs ('+ap.shipped.toLocaleString()+'u)')+'</span></div>'+
            '<div class="fa-row"><span class="fa-row-label">Units/pkg</span><input class="fa-input" data-fa-key="unitsPerPkgAp" type="number" min="0" step="0.1" value="'+s.unitsPerPkgAp+'"></div>'+
            '<div class="fa-row"><span class="fa-row-label">ULDs ('+s.pkgsPerUld+'/ULD)</span><span class="fa-big">'+(isNaN(apP)?'—':ulds)+'</span></div>'+
        '</div>'+
        '<div class="fa-section"><div class="fa-section-title">DWT1 — Go-Karts</div>'+
            '<div class="fa-row"><span class="fa-row-label">CPT</span><input class="fa-input" data-fa-key="dwtCpt" type="text" value="'+s.dwtCpt+'"></div>'+
            '<div class="fa-row"><span class="fa-row-label">Units to flow</span><span class="fa-row-value">'+(isNaN(dw.units)?'—':dw.units.toLocaleString())+'</span></div>'+
            '<div class="fa-row"><span class="fa-row-label">In Ship Dock</span><span class="fa-row-value">'+(isNaN(dw.shipped)?'—':'~'+sKt+' Karts ('+dw.shipped.toLocaleString()+'u)')+'</span></div>'+
            '<div class="fa-row"><span class="fa-row-label">Units/pkg</span><input class="fa-input" data-fa-key="unitsPerPkgDwt" type="number" min="0" step="0.1" value="'+s.unitsPerPkgDwt+'"></div>'+
            '<div class="fa-row"><span class="fa-row-label">Go-Karts ('+s.pkgsPerKart+'/kart)</span><span class="fa-big">'+(isNaN(dwP)?'—':kts)+'</span></div>'+
        '</div>';
    }

    // ═══════════════ SSP ═══════════════

    var SSP_URL='https://trans-logistics-fe.amazon.com/ssp/dock/hrz/ob?';
    var SSP_MO={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    function perthNow(){var n=new Date(),u=n.getTime()+n.getTimezoneOffset()*60000;return new Date(u+8*3600000);}
    function parseSspD(s){var m=/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\s+(\d{1,2}):(\d{2})$/.exec((s||'').trim());if(!m)return null;var y=m[3].length===2?2000+parseInt(m[3],10):parseInt(m[3],10);var mo=SSP_MO[m[2].toLowerCase()];if(mo===undefined)return null;return new Date(y,mo,parseInt(m[1],10),parseInt(m[4],10),parseInt(m[5],10));}
    function fmtCd(ms){var p=ms<0,mn=Math.round(Math.abs(ms)/60000),h=Math.floor(mn/60),mm=mn%60,t=(h>0?h+'h ':'')+mm+'m';return p?t+' ago':'in '+t;}
    function fmtAge(ms){var m=Math.floor(ms/60000);return m<1?'just now':m+'m ago';}
    function findD(obj,kr,vp,d){d=d||0;if(!obj||typeof obj!=='object'||d>6)return undefined;var k,v;for(k in obj){v=obj[k];if((typeof v==='string'||typeof v==='number')&&(!kr||kr.test(k))&&(!vp||vp(v)))return v;}for(k in obj){if(obj[k]&&typeof obj[k]==='object'){var r=findD(obj[k],kr,vp,d+1);if(r!==undefined)return r;}}return undefined;}

    function installSspCompanion(){
        var code='('+function(){
            var oO=XMLHttpRequest.prototype.open,oS=XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open=function(m,url){this.__su=url;return oO.apply(this,arguments);};
            XMLHttpRequest.prototype.send=function(body){
                var self=this,b=(typeof body==='string')?body:'';
                if(typeof self.__su==='string'&&self.__su.indexOf('fetchdata')!==-1&&/entity=(getDefaultOutboundDockView|getContainerCountForCPT)/.test(b)){
                    self.addEventListener('load',function(){try{window.postMessage({__ssp:true,body:b,resp:self.responseText},window.location.origin);}catch(e){}});
                }
                return oS.apply(this,arguments);
            };
        }.toString()+')();';
        var s=document.createElement('script');s.textContent=code;(document.head||document.documentElement).appendChild(s);s.remove();
        window.addEventListener('message',function(ev){
            var d=ev.data;if(!d||d.__ssp!==true)return;
            try{var j=JSON.parse(d.resp);
                if(d.body.indexOf('entity=getDefaultOutboundDockView')!==-1)saveSspCache(function(c){c.rows=(j.ret&&j.ret.aaData)||[];});
                else if(d.body.indexOf('entity=getContainerCountForCPT')!==-1)saveSspCache(function(c){c.cptCounts=(j.ret&&j.ret.cptContainerCountMap)||{};});
            }catch(e){}
        });
    }

    function sspInfo(row){
        var lo=row.load||{},tr=row.trailer||{};
        var isU=function(v){return typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(v);};
        var cpt=lo.criticalPullTime||findD(row,/criticalpull/i);
        var sdt=findD(lo,/scheduleddeparture/i)||cpt;
        return{vrId:lo.vrId||findD(row,/^vrid$/i)||'?',route:findD(row,null,function(v){return typeof v==='string'&&/^[A-Z0-9]{3,5}->/.test(v);})||'?',status:findD(lo,/status/i,function(v){return typeof v==='string'&&v.length>1;})||'Unknown',door:findD(row,null,function(v){return typeof v==='string'&&/^DD\d+/i.test(v);})||tr.location||'?',trailerNumber:tr.trailerNumber||'?',cpt:cpt||null,sdt:sdt||null,groupId:findD(lo,/group/i,isU)||findD(row,/group/i,isU)||null,when:parseSspD(cpt)||parseSspD(sdt)};
    }
    function pickClosest(infos){var now=perthNow().getTime(),fu=null,pa=null;for(var i=0;i<infos.length;i++){if(!infos[i].when)continue;var d=infos[i].when.getTime()-now;if(d>=0){if(!fu||d<fu.d)fu={i:infos[i],d:d};}else{if(!pa||d>pa.d)pa={i:infos[i],d:d};}}return fu||pa||null;}
    function sR(l,v){return '<div class="fa-row"><span class="fa-row-label">'+l+'</span><span class="fa-row-value">'+v+'</span></div>';}
    var SSP_LNK='<a href="'+SSP_URL+'" target="_blank" rel="noopener" style="color:#b2ebf2;font-size:12px;">Open SSP ↗</a>';

    function loadSsp(){
        var box=document.getElementById('ssp-content');if(!box)return;
        var cache=readSspCache();
        if(!cache||!cache.rows||!cache.rows.length){box.innerHTML='<div class="fa-note">No SSP data yet. Open SSP in another tab.</div>'+SSP_LNK;return;}
        var age=Date.now()-(cache.updatedAt||0);
        var infos=cache.rows.map(function(r){return sspInfo(r);});
        var pick=pickClosest(infos);if(!pick){box.innerHTML='<div class="fa-note">Could not read departure times.</div>'+SSP_LNK;return;}
        var inf=pick.i,ch='';
        var d=(inf.groupId&&cache.cptCounts)?cache.cptCounts[inf.groupId]:null;
        if(d){var P=function(o){return(o&&typeof o.P==='number')?o.P:0;};var tot=P(d.total),ld=P(d.loaded),ts=tot-ld-P(d.departed);ch='<div class="fa-section-title" style="margin-top:10px;">Packages</div>'+sR('Total',tot.toLocaleString())+sR('Stacked',P(d.stacked).toLocaleString())+sR('Loaded',ld.toLocaleString())+'<div class="fa-row"><span class="fa-row-label">Left to scan</span><span class="fa-big '+(ts>0?'fa-hc-more':'')+'">'+ts.toLocaleString()+'</span></div>';}
        else ch='<div class="fa-note">Container details not captured yet.</div>';
        var st=age>SSP_STALE_MS?'<div class="fa-note fa-hc-more">⚠ Data '+fmtAge(age)+' old.</div>':'<div class="fa-note">Updated '+fmtAge(age)+'.</div>';
        box.innerHTML=sR('Route',inf.route+' <span style="color:rgba(255,255,255,0.5)">('+inf.vrId+')</span>')+'<div class="fa-row"><span class="fa-row-label">CPT</span><span class="fa-big">'+(inf.cpt||inf.sdt||'?')+'</span></div>'+sR('Countdown',fmtCd(pick.d))+sR('Status',inf.status)+sR('Door',inf.door+' · '+inf.trailerNumber)+ch+st+SSP_LNK;
    }

    // ═══════════════ ATLAS ═══════════════

    var ATLAS_GQL='https://atlas.qubit.amazon.dev/graphql';
    var ATLAS_PAGE='https://atlas.qubit.amazon.dev/reporting';
    var ATLAS_HASH='743a06934850c780d0251262189e145dabc81be58857f25271e2b26a4fd4f4ed';
    var ATLAS_Q={Q1:[8,0,10,0],Q2:[10,15,12,30],Q3:[13,0,15,30],Q4:[15,45,18,0],Shift:[8,0,18,0]};
    var atlasQ='auto';

    function atlasQId(){var n=perthNow(),m=n.getHours()*60+n.getMinutes(),c='Q1';['Q1','Q2','Q3','Q4'].forEach(function(id){var q=ATLAS_Q[id];if(m>=q[0]*60+q[1])c=id;});return c;}
    function atlasEp(qid){var q=ATLAS_Q[qid],n=perthNow(),y=n.getFullYear(),mo=n.getMonth(),d=n.getDate();
        return{start:Date.UTC(y,mo,d,q[0]-8,q[1])/1000,end:Date.UTC(y,mo,d,q[2]-8,q[3])/1000,
            label:String(q[0]).padStart(2,'0')+':'+String(q[1]).padStart(2,'0')+'–'+String(q[2]).padStart(2,'0')+':'+String(q[3]).padStart(2,'0'),
            dateStr:y+'-'+String(mo+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'),
            startHM:String(q[0]).padStart(2,'0')+':'+String(q[1]).padStart(2,'0')+':00',
            endHM:String(q[2]).padStart(2,'0')+':'+String(q[3]).padStart(2,'0')+':00'};}
    function atlasLnk(ep){return ATLAS_PAGE+'?aggregateType=WAREHOUSE_ID&queryType=NORMAL&targetProcess=SHIP&startDate='+ep.dateStr+'&startTime='+encodeURIComponent(ep.startHM)+'&endDate='+ep.dateStr+'&endTime='+encodeURIComponent(ep.endHM)+'&warehouseId='+encodeURIComponent(SITE_CODE);}

    function loadAtlas(){
        var box=document.getElementById('atlas-content');if(!box)return;
        var qid=(atlasQ==='auto')?atlasQId():atlasQ,ep=atlasEp(qid);
        box.innerHTML='<div class="fa-note">⏳ Loading '+qid+' ('+ep.label+')…</div>';
        GM_xmlhttpRequest({method:'POST',url:ATLAS_GQL,
            headers:{'Content-Type':'application/json','Origin':'https://atlas.qubit.amazon.dev','Referer':ATLAS_PAGE},
            data:JSON.stringify({variables:{warehouseId:SITE_CODE,department:'SHIP',timeRanges:[{startTime:ep.start,endTime:ep.end}]},extensions:{persistedQuery:{version:1,sha256Hash:ATLAS_HASH}}}),
            onload:function(r){
                var b=document.getElementById('atlas-content');if(!b)return;
                if(r.status!==200){b.innerHTML='<div class="fa-note">⚠️ Status '+r.status+'. <a href="'+atlasLnk(ep)+'" target="_blank" style="color:#b2ebf2">Open ATLAS ↗</a></div>';return;}
                try{
                    var j=JSON.parse(r.responseText);
                    if(j.errors&&j.errors.length){b.innerHTML='<div class="fa-note">⚠️ '+j.errors[0].message+'</div>';return;}
                    var rep=j.data&&j.data.getReportingByWarehouseId;if(!rep){b.innerHTML='<div class="fa-note">No data.</div>';return;}
                    var totals=rep.totalsReports||[],ts=null,thr=null;
                    for(var i=0;i<totals.length;i++){if(totals[i].defectType==='Total Ship')ts=totals[i];if(totals[i].defectTypeAltName==='SHIP_FAILED_MOVES'&&totals[i].threshold!=null)thr=totals[i].threshold;}
                    var html='<div class="fa-note" style="margin-bottom:6px;">'+qid+' · '+ep.label+' Perth · '+ep.dateStr+'</div>';
                    if(ts){var dpmo=ts.metricValue,ov=(thr!=null&&dpmo>thr);html+=sR('Defects',ts.defectCount.toLocaleString())+sR('Opportunities',ts.opportunities.toLocaleString())+'<div class="fa-row"><span class="fa-row-label">DPMO'+(thr!=null?' (≤'+thr.toLocaleString()+')':'')+'</span><span class="fa-big '+(ov?'fa-hc-more':'fa-hc-less')+'">'+dpmo.toLocaleString()+'</span></div>';}
                    var rows=[],raw=(rep.rawReports&&rep.rawReports[0]&&rep.rawReports[0].processLevelReport)||[];
                    for(var r2=0;r2<raw.length;r2++){var pr=raw[r2],opp=0;for(var dm=0;dm<(pr.defectMap||[]).length;dm++)if(pr.defectMap[dm].k==='Opportunities')opp=pr.defectMap[dm].v;rows.push({user:(pr.aggregationField||'').replace(SITE_CODE+'-',''),manager:pr.managerId||'-',defects:pr.totalDefects||0,opp:opp,dpmo:pr.metricValue||0});}
                    rows.sort(function(a,bv){return bv.dpmo-a.dpmo||bv.defects-a.defects;});
                    if(rows.length){html+='<table class="atlas-table"><thead><tr><th>User</th><th>Manager</th><th>Defects</th><th>DPMO</th><th>Opps</th></tr></thead><tbody>';for(var t2=0;t2<rows.length;t2++){var ov2=(thr!=null&&rows[t2].dpmo>thr);html+='<tr><td>'+rows[t2].user+'</td><td>'+rows[t2].manager+'</td><td>'+rows[t2].defects.toLocaleString()+'</td><td class="'+(ov2?'fa-hc-more':'')+'">'+rows[t2].dpmo.toLocaleString()+'</td><td>'+rows[t2].opp.toLocaleString()+'</td></tr>';}html+='</tbody></table>';}
                    html+='<a href="'+atlasLnk(ep)+'" target="_blank" style="color:#b2ebf2;font-size:12px;">Open in ATLAS ↗</a>';
                    b.innerHTML=html;
                }catch(e){b.innerHTML='<div class="fa-note">⚠️ Not JSON — open ATLAS once to sign in.</div>';}
            },
            onerror:function(){var b=document.getElementById('atlas-content');if(b)b.innerHTML='<div class="fa-note">⚠️ Request failed.</div>';}
        });
    }

    // ─── Tool display area ───
    function toolDisplayHTML(s){
        var tl=null;for(var i=0;i<FA_TOOLS.length;i++)if(FA_TOOLS[i].id===s.activeTool){tl=FA_TOOLS[i];break;}
        var inner;
        if(!tl){inner='<div class="fa-placeholder">Select a tool.</div>';}
        else if(tl.id==='containers'){inner=containerHTML(s);}
        else if(tl.id==='ssp'){inner='<div class="fa-section" style="flex:1;"><div class="fa-section-title">SSP — Closest Departure <span id="ssp-refresh" style="cursor:pointer;float:right;color:#b2ebf2;">⟳ Refresh</span></div><div id="ssp-content"></div></div>';}
        else if(tl.id==='atlas'){
            var qOpts='<option value="auto"'+(atlasQ==='auto'?' selected':'')+'>Auto (current)</option>';
            ['Q1','Q2','Q3','Q4','Shift'].forEach(function(qid){qOpts+='<option value="'+qid+'"'+(atlasQ===qid?' selected':'')+'>'+qid+'</option>';});
            inner='<div class="fa-section" style="flex:1;"><div class="fa-section-title">ATLAS — Ship Quality <span style="float:right;"><select id="atlas-quarter" class="fa-select" style="width:auto;display:inline-block;margin-right:10px;">'+qOpts+'</select><span id="atlas-refresh" style="cursor:pointer;color:#b2ebf2;">⟳ Refresh</span></span></div><div id="atlas-content"></div></div>';
        }else{inner='<div class="fa-placeholder">Select a tool.</div>';}
        return '<div class="fa-tool-display">'+inner+'</div>';
    }

    // ─── Render panel ───
    function renderFaPanel(){
        var panel=document.getElementById('fa-panel');if(!panel)return;
        var s=loadS();
        var tabs=[{id:'ship',label:'🔵 Ship'},{id:'pick',label:'🟢 Pick'},{id:'pack',label:'🟠 Pack'}];
        var html='<div class="fa-tabs" role="tablist">';
        for(var i=0;i<tabs.length;i++){var a=(s.activeTab===tabs[i].id);html+='<div class="fa-tab'+(a?' active':'')+'" role="tab" tabindex="0" data-fa-tab="'+tabs[i].id+'">'+tabs[i].label+'</div>';}
        html+='</div>';

        // All 3 tabs now show crew; Ship tab also has HC + tool picker
        if(s.activeTab==='ship'){
            html+='<div class="fa-tab-body">'+shipHcHTML(s)+toolPickHTML(s)+toolDisplayHTML(s)+'</div>';
        }
        // Crew section for all tabs
        html+='<div style="margin-top:'+(s.activeTab==='ship'?'14':'0')+'px;">'+
            (s.activeTab!=='ship'?'<div style="margin-bottom:8px;font-size:11px;font-weight:700;color:#b2ebf2;text-transform:uppercase;letter-spacing:0.8px;">👥 Crew — '+s.activeTab.charAt(0).toUpperCase()+s.activeTab.slice(1)+'</div>':
            '<div style="margin-bottom:8px;font-size:11px;font-weight:700;color:#b2ebf2;text-transform:uppercase;letter-spacing:0.8px;">👥 Crew</div>')+
            crewSectionHTML(s)+
        '</div>';

        panel.innerHTML=html;

        // Tab switching
        var tabEls=panel.querySelectorAll('.fa-tab');
        function swTab(){var c=loadS();c.activeTab=this.getAttribute('data-fa-tab');saveS(c);renderFaPanel();}
        for(var te=0;te<tabEls.length;te++){
            tabEls[te].addEventListener('click',swTab);
            tabEls[te].addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();swTab.call(this);}});
        }
        // Tool dropdown
        var ts=panel.querySelector('#fa-tool-select');
        if(ts)ts.addEventListener('change',function(){var c=loadS();c.activeTool=this.value;saveS(c);renderFaPanel();});
        // fa-input persistence
        var inp=panel.querySelectorAll('.fa-input');
        for(var n=0;n<inp.length;n++){inp[n].addEventListener('change',function(){var c=loadS();c[this.getAttribute('data-fa-key')]=(this.type==='number')?(parseFloat(this.value)||0):this.value.trim();saveS(c);renderFaPanel();});}
        // Crew refresh buttons
        wireCrewBlocks();
        // Auto-load crew blocks with saved processIds
        autoLoadCrew(s);
        // SSP
        var sspBtn=panel.querySelector('#ssp-refresh');if(sspBtn){sspBtn.addEventListener('click',loadSsp);loadSsp();}
        // ATLAS
        var atBtn=panel.querySelector('#atlas-refresh');
        if(atBtn){
            atBtn.addEventListener('click',loadAtlas);
            var atSel=panel.querySelector('#atlas-quarter');
            if(atSel)atSel.addEventListener('change',function(){atlasQ=this.value;loadAtlas();});
            loadAtlas();
        }
    }

    // ─── Bar ───
    function buildBar(data,statusMsg){
        var old=document.getElementById('ob-bar');if(old)old.remove();
        var bar=document.createElement('div');bar.id='ob-bar';
        if(statusMsg){bar.innerHTML='<div class="ob-status">'+statusMsg+'</div>';injectBar(bar);return;}
        function cell(title,vol,rate){
            if(!vol)return '<div class="ob-cell"><div class="ob-cell-title">'+title+'</div><div class="ob-notfound">Not found</div></div>';
            return '<div class="ob-cell"><div class="ob-cell-title">'+title+'</div><div class="ob-cell-row"><span class="ob-vol">'+vol+'</span><span class="ob-rate">Rate: '+rate+'</span></div></div>';
        }
        var html='';
        var pk=data?data.pick:null;       html+=cell('Pick - Total',pk?pk.vol:null,pk?pk.rate:null);
        var ps=data?data.packSingles:null; html+=cell('Pack Singles - Total',ps?ps.vol:null,ps?ps.rate:null);
        var pm=data?data.packMultis:null;  html+=cell('Pack Multis - Total',pm?pm.vol:null,pm?pm.rate:null);
        var ob=data?data.obTotal:null;     html+=cell('OB - TOTAL',ob?ob.vol:null,ob?ob.rate:null);
        var pkR=pk?parseN(pk.rate):NaN,sR=ps?parseN(ps.rate):NaN,mR=pm?parseN(pm.rate):NaN,pavg=NaN;
        if(!isNaN(sR)&&!isNaN(mR))pavg=(sR+mR)/2;else if(!isNaN(sR))pavg=sR;else if(!isNaN(mR))pavg=mR;
        html+='<div class="ob-cell rate-cell"><div class="ob-cell-title">Average Rate</div><div class="ob-cell-row"><span class="ob-rate-big">Pick: '+fmtR(pkR)+'</span></div><div class="ob-cell-row"><span class="ob-rate-big">Pack: '+fmtR(pavg)+'</span></div></div>';
        html+='<div class="ob-cell fa-btn-cell" id="fa-toggle" role="button" tabindex="0" aria-expanded="false"><span class="fa-btn-label">⚡ Flow Assist</span></div>';
        lastPackAvg=pavg;
        bar.innerHTML=html;injectBar(bar);wireFA(bar);
    }

    function injectBar(bar){
        var a=document.querySelector('#main-content')||document.querySelector('.content-area')||document.querySelector('#content')||document.querySelector('body > div');
        if(a&&a.parentElement)a.parentElement.insertBefore(bar,a);else document.body.insertBefore(bar,document.body.firstChild);
    }

    function wireFA(bar){
        var panel=document.getElementById('fa-panel');
        if(!panel){panel=document.createElement('div');panel.id='fa-panel';}
        bar.parentElement.insertBefore(panel,bar.nextSibling);
        var btn=document.getElementById('fa-toggle');if(!btn)return;
        function toggle(){var open=panel.classList.toggle('open');btn.setAttribute('aria-expanded',open?'true':'false');if(open)renderFaPanel();}
        btn.addEventListener('click',toggle);
        btn.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}});
    }

    // ─── Main fetch ───
    function fetchAndRender(){
        buildBar(null,'⏳ Loading OB data from FCLM...');
        GM_xmlhttpRequest({method:'GET',url:buildFclmUrl(),
            onload:function(r){
                if(r.status!==200){buildBar(null,'⚠️ FCLM returned status '+r.status+'. Make sure you are logged in.');return;}
                var data=extractFromHTML(r.responseText);
                if(!data){buildBar(null,'⚠️ No OB data found in FCLM response.');return;}
                buildBar(data,null);
            },
            onerror:function(){buildBar(null,'⚠️ Failed to fetch FCLM data.');}
        });
    }

    setTimeout(fetchAndRender, 1500);

})();