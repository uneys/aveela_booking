
(function(){
  var NS='http://www.w3.org/2000/svg', reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  var seed=11; function rnd(){seed=(seed*16807)%2147483647;return (seed-1)/2147483646}
  function el(tag,attrs,parent){var e=document.createElementNS(NS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);if(parent)parent.appendChild(e);return e}

  /* ----- scenery: palms, bush line, tables, mullions, festoons ----- */
  function palm(g,x,base,h,lean,fill){
    var tx=x+lean, ty=base-h;
    el('path',{d:'M'+(x-h*.022)+','+base+' Q'+(x+lean*.2)+','+(base-h*.55)+' '+(tx-h*.012)+','+ty+' L'+(tx+h*.012)+','+ty+' Q'+(x+lean*.2+h*.03)+','+(base-h*.55)+' '+(x+h*.022)+','+base+'Z',fill:fill},g);
    var n=9;
    for(var i=0;i<n;i++){
      var a=(-170+i*(160/(n-1))+(rnd()*14-7))*Math.PI/180, L=h*(.36+rnd()*.12);
      var ex=tx+Math.cos(a)*L, ey=ty+Math.sin(a)*L*.55+L*.38*Math.abs(Math.cos(a));
      var mx=tx+Math.cos(a)*L*.5, my=ty+Math.sin(a)*L*.5-L*.12, w=L*.09;
      el('path',{d:'M'+tx+','+ty+' Q'+(mx-w)+','+(my-w)+' '+ex+','+ey+' Q'+(mx+w)+','+(my+w)+' '+tx+','+ty+'Z',fill:fill},g);
    }
  }
  var far=document.getElementById('far'), mid=document.getElementById('mid'), near=document.getElementById('near'), x;
  for(x=-300;x<2000;x+=26+rnd()*30) el('circle',{cx:x,cy:860+rnd()*14,r:24+rnd()*30,fill:'#7680a0'},far);
  for(x=-300;x<2000;x+=110+rnd()*140) palm(far,x,870,220+rnd()*160,(rnd()-.5)*90,'#7680a0');
  [[170,560,-60],[330,470,40],[1110,520,-40],[1290,600,60],[1500,480,-30],[1660,560,40],[-40,500,30]].forEach(function(a){palm(mid,a[0],884,a[1],a[2],'#435173')});
  [[1540,1110,760,-120],[1820,1060,640,-60],[-40,1100,700,110]].forEach(function(a){palm(near,a[0],a[1],a[2],a[3],'#121a29')});

  /* tree after the logo: short trunk, fan of branches, scalloped leafy clumps */
  (function(){
    var g=document.getElementById('tree'), fill='#1b2740', tx=710, base=640;
    el('path',{d:'M690,'+base+' C694,600 700,575 702,548 L718,548 C720,575 726,600 730,'+base+'Z',fill:fill},g);
    var br=[[-250,500,7],[-175,470,8],[-95,440,8],[-30,420,7],[30,420,7],[95,440,8],[175,470,8],[250,500,7],[-140,520,5],[140,520,5],[-60,500,5],[60,500,5]];
    br.forEach(function(b){
      var ex=tx+b[0], ey=b[1], sx=tx+b[0]*.06, sy=560;
      el('path',{d:'M'+sx+','+sy+' Q'+(tx+b[0]*.45)+','+(sy-10)+' '+ex+','+ey,stroke:fill,'stroke-width':b[2],'stroke-linecap':'round',fill:'none'},g);
      el('path',{d:'M'+(tx+b[0]*.55)+','+(sy-14)+' q'+(b[0]*.12)+','+(-30)+' '+(b[0]*.2)+','+(-55),stroke:fill,'stroke-width':b[2]*.45,'stroke-linecap':'round',fill:'none'},g);
    });
    function clump(cx,cy,r){
      var n=Math.round(r/4.2), d="";
      for(var i=0;i<=n;i++){
        var a=i/n*Math.PI*2, rr=r*(.94+rnd()*.1), px=cx+Math.cos(a)*rr, py=cy+Math.sin(a)*rr*.86;
        if(i===0){d+='M'+px.toFixed(1)+','+py.toFixed(1);continue}
        var am=(i-.5)/n*Math.PI*2, ro=r*(1.09+rnd()*.05);
        d+=' Q'+(cx+Math.cos(am)*ro).toFixed(1)+','+(cy+Math.sin(am)*ro*.86).toFixed(1)+' '+px.toFixed(1)+','+py.toFixed(1);
      }
      el('path',{d:d+'Z',fill:fill},g);
    }
    [[710,360,96],[600,395,88],[820,395,88],[505,450,74],[915,450,74],[440,505,54],[980,505,54],
     [650,455,80],[770,455,80],[560,490,62],[860,490,62],[710,440,90]].forEach(function(c){clump(c[0],c[1],c[2])});
  })();

  var $=function(id){return document.getElementById(id)};
  /* ----- lightbox ----- */
  (function(){
    var lb=$('lb'),stage=$('lbStage'),cap=$('lbCap'),shots=[].slice.call(document.querySelectorAll('.shot')),cur=0,last=null;
    function show(i){cur=(i+shots.length)%shots.length;var o=shots[cur].querySelector('img'),src=document.createElement('img');src.src=o.src;src.alt=o.alt;stage.innerHTML='';stage.appendChild(src);cap.textContent=shots[cur].querySelector('.cap').textContent}
    function openLb(i){last=document.activeElement;show(i);lb.hidden=false;requestAnimationFrame(function(){lb.classList.add('on')});$('lbX').focus();document.body.style.overflow='hidden'}
    function close(){lb.classList.remove('on');document.body.style.overflow='';setTimeout(function(){lb.hidden=true},reduce?0:350);if(last)last.focus()}
    shots.forEach(function(b,i){b.addEventListener('click',function(){openLb(i)})});
    $('lbX').addEventListener('click',close);
    $('lbPrev').addEventListener('click',function(){show(cur-1)});
    $('lbNext').addEventListener('click',function(){show(cur+1)});
    lb.addEventListener('click',function(e){if(e.target===lb)close()});
    document.addEventListener('keydown',function(e){if(lb.hidden)return;
      if(e.key==='Escape')close();else if(e.key==='ArrowLeft')show(cur-1);else if(e.key==='ArrowRight')show(cur+1);
      else if(e.key==='Tab'){var f=[$('lbX'),$('lbPrev'),$('lbNext')],k=f.indexOf(document.activeElement);e.preventDefault();f[(k+(e.shiftKey?-1:1)+3)%3].focus()}});
  })();

  var tables=document.getElementById('tables');
  [474,552,630,790,868,946].forEach(function(tx,i){
    var ty=i%2?856:860;
    el('path',{d:'M'+(tx-30)+','+(ty-6)+' q30,-12 60,0 l5,30 h-70z'},tables);
    el('rect',{x:tx-44,y:ty-2,width:8,height:26,rx:3},tables);el('rect',{x:tx+36,y:ty-2,width:8,height:26,rx:3},tables);
    el('rect',{x:tx-1.2,y:ty-30,width:2.4,height:22},tables);el('circle',{cx:tx,cy:ty-33,r:7},tables);
  });
  el('path',{d:'M680,880 v-50 a30,30 0 0 1 60,0 v50z'},tables); /* floral arch at the doors */
  var mul=document.getElementById('mullions'), d='';
  for(x=432+69.5;x<988;x+=69.5) d+='M'+x.toFixed(1)+',660 v220';
  el('path',{d:d+'M432,812 h556'},mul);

  var lights=document.getElementById('lights');
  function strand(x0,y0,x1,y1,sag,n){
    var cx=(x0+x1)/2, cy=Math.max(y0,y1)+sag;
    el('path',{d:'M'+x0+','+y0+' Q'+cx+','+cy+' '+x1+','+y1,fill:'none',stroke:'#141c2c','stroke-width':1.6},lights);
    var dim=el('g',{'class':'dimonly',fill:'#8d94ad'},lights), lit=el('g',{'class':'glow'},lights);
    var halo=el('g',{fill:'url(#halo)'},lit), bulbs=el('g',{fill:'#ffeab8'},lit);
    for(var i=1;i<n;i++){var t=i/n,u=1-t,bx=u*u*x0+2*u*t*cx+t*t*x1,by=u*u*y0+2*u*t*cy+t*t*y1+4;
      el('circle',{cx:bx,cy:by,r:2.6},dim);el('circle',{cx:bx,cy:by,r:20},halo);
      el('circle',{cx:bx,cy:by,r:3.4,'class':'bulb',style:'animation-delay:'+(-rnd()*3.4).toFixed(2)+'s'},bulbs);}
  }
  strand(1032,646,1180,700,40,7);strand(1180,700,1380,690,46,9);strand(1032,660,1380,690,90,14);

  function tufts(g,n,x0,x1,y0,y1,stroke,op){
    var d='';
    for(var i=0;i<n;i++){var tx=x0+rnd()*(x1-x0), ty=y0+Math.pow(rnd(),1.4)*(y1-y0), s=6+((ty-y0)/(y1-y0))*14;
      d+='M'+tx.toFixed(0)+','+ty.toFixed(0)+'l'+(-s*.4).toFixed(1)+','+(-s).toFixed(1)+'M'+tx.toFixed(0)+','+ty.toFixed(0)+'l'+(s*.1).toFixed(1)+','+(-s*1.2).toFixed(1)+'M'+tx.toFixed(0)+','+ty.toFixed(0)+'l'+(s*.5).toFixed(1)+','+(-s*.9).toFixed(1);}
    el('path',{d:d,stroke:stroke,'stroke-width':2,'stroke-linecap':'round',fill:'none',opacity:op},g);
  }
  tufts(document.getElementById('tufts'),240,-300,2000,900,1400,'#111827',.7);

  var scene=document.getElementById('scene'), hero=document.querySelector('.hero');
  function fit(){
    var w=hero.clientWidth,h=hero.clientHeight;
    if(w/h<.85){
      var s=w/800, top=document.querySelector('.card').getBoundingClientRect().top-hero.getBoundingClientRect().top;
      scene.setAttribute('viewBox','310 '+(886-(top-6)/s).toFixed(0)+' 800 '+(h/s).toFixed(0));
    } else scene.setAttribute('viewBox','60 0 1600 1200');
  }
  fit(); addEventListener('resize',fit);
  if(document.fonts&&document.fonts.ready) document.fonts.ready.then(fit);

  /* ----- intro: count, draw the frame, lights on, reveal ----- */
  var frame=document.getElementById('frame'), rect=frame.querySelector('.border rect'), count=document.getElementById('count'), raf=0, timers=[];
  var keys=[[0,0],[.14,0],[.3,.12],[.48,.43],[.62,.71],[.75,.87],[.86,.95],[.94,.99],[1,1]];
  function prog(t){for(var i=1;i<keys.length;i++){if(t<=keys[i][0]){var a=keys[i-1],b=keys[i];return a[1]+(b[1]-a[1])*(t-a[0])/(b[0]-a[0])}}return 1}
  function later(f,ms){timers.push(setTimeout(f,ms))}
  function intro(){
    cancelAnimationFrame(raf);timers.forEach(clearTimeout);timers=[];
    if(reduce){hero.classList.add('lit');frame.classList.add('in');count.classList.add('gone');rect.style.strokeDashoffset=0;return}
    hero.classList.remove('lit');frame.classList.remove('in');count.classList.remove('gone');
    rect.style.strokeDashoffset=1;count.textContent='0%';
    var start=null,dur=2700;
    function step(now){
      if(start===null)start=now;
      var t=Math.min(1,(now-start)/dur),p=prog(t);
      rect.style.strokeDashoffset=1-p;count.textContent=Math.round(p*100)+'%';
      if(t<1)raf=requestAnimationFrame(step);
      else{later(function(){hero.classList.add('lit');count.classList.add('gone')},320);later(function(){frame.classList.add('in')},1050)}
    }
    later(function(){raf=requestAnimationFrame(step)},450);
  }
  intro();
  document.getElementById('replay').addEventListener('click',function(){scrollTo({top:0,behavior:reduce?'auto':'smooth'});later(intro,reduce?0:650)});

  var panels=[].slice.call(document.querySelectorAll('.draw'));
  function open(p){
    var r=p.querySelector('.border rect');
    if(reduce){r.style.strokeDashoffset=0;p.classList.add('in');return}
    r.style.transition='stroke-dashoffset 1.5s cubic-bezier(.5,0,.2,1)';r.style.strokeDashoffset=0;
    setTimeout(function(){p.classList.add('in')},450);
  }
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){open(e.target);io.unobserve(e.target)}})},{threshold:.12});
    panels.forEach(function(p){io.observe(p)});
  } else panels.forEach(open);

  /* ----- contact details: fill these in; empty ones stay hidden ----- */
  var VENUE={
    name:'Aveela Event Space',
    address:'',          /* e.g. 'Street name, Malé' */
    phone:'',            /* e.g. '+960 7xx xxxx' */
    email:'',
    instagram:'aveelaeventspace',
    viewings:'By appointment. Message us to arrange a walk-through.'
  };
  (function(){
    var q=encodeURIComponent(VENUE.address?VENUE.name+', '+VENUE.address:VENUE.name);
    document.getElementById('mapLink').href='https://www.google.com/maps/search/?api=1&query='+q;
    document.getElementById('dirBtn').href='https://www.google.com/maps/dir/?api=1&destination='+q;
    var rows=[];
    if(VENUE.address)rows.push(['Address',document.createTextNode(VENUE.address)]);
    if(VENUE.phone){var t=document.createElement('a');t.href='tel:'+VENUE.phone.replace(/\s/g,'');t.textContent=VENUE.phone;rows.push(['Phone',t])}
    if(VENUE.email){var m=document.createElement('a');m.href='mailto:'+VENUE.email;m.textContent=VENUE.email;rows.push(['Email',m])}
    var ig=document.createElement('a');ig.href='https://www.instagram.com/'+VENUE.instagram;ig.target='_blank';ig.rel='noopener';ig.textContent='@'+VENUE.instagram;
    rows.push(['Instagram',ig]);
    rows.push(['Viewings',document.createTextNode(VENUE.viewings)]);
    var dl=document.getElementById('info');
    rows.forEach(function(r){var w=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=r[0];dd.appendChild(r[1]);w.appendChild(dt);w.appendChild(dd);dl.appendChild(w)});
  })();

  /* ----- floating menu: appears once the hero menu scrolls away ----- */
  (function(){
    var fnav=$('fnav'), now=$('fnavNow'), heroNav=document.querySelector('.frame nav'),
        links=[].slice.call(fnav.querySelectorAll('.fnav-links a:not([data-ext])')),
        secs=links.map(function(a){return document.querySelector(a.getAttribute('href'))});
    function setShow(on){fnav.classList.toggle('show',on);if(on)fnav.removeAttribute('inert');else fnav.setAttribute('inert','')}
    if('IntersectionObserver' in window){
      new IntersectionObserver(function(es){setShow(!es[0].isIntersecting&&es[0].boundingClientRect.top<0)},{threshold:0}).observe(heroNav);
    }
    function mark(){
      var y=innerHeight*.35, cur=-1;
      secs.forEach(function(sec,i){var r=sec.getBoundingClientRect();if(r.top<=y&&r.bottom>y)cur=i});
      links.forEach(function(a,i){if(i===cur)a.setAttribute('aria-current','true');else a.removeAttribute('aria-current')});
      now.textContent=cur>=0?links[cur].textContent:'';
    }
    addEventListener('scroll',mark,{passive:true});addEventListener('resize',mark);mark();
    fnav.addEventListener('click',function(e){
      var a=e.target.closest('a');if(!a||a.hasAttribute('data-ext'))return;e.preventDefault();
      if(a.hasAttribute('data-book')){goBook();return}
      var t=document.querySelector(a.getAttribute('href'));if(t)t.scrollIntoView({behavior:reduce?'auto':'smooth'});
    });
  })();

  /* ----- booking card: live availability, sign-in, request ----- */
  var $=function(id){return document.getElementById(id)};
  var A=window.Aveela;
  var kinds={
    wedding:{title:'Weddings and receptions in the Hall',type:'Wedding'},
    party:{title:'Birthdays, showers and private parties',type:'Party'},
    corporate:{title:'Conferences, launches and company dinners',type:'Corporate'}
  };
  var cur='wedding', pickedType='Wedding', swap=$('swap'), date=$('date'), fromSel=$('from'), toSel=$('to'),
      guests=$('guests'), slots=$('slots'), avail=$('avail'), ask=$('ask'), cfg=null, months={}, lastCheck=null;

  function paintKind(){$('eTitle').textContent=kinds[cur].title}
  function setKind(k,animate,type){
    cur=k;pickedType=type||kinds[k].type;
    document.querySelectorAll('.tabs button').forEach(function(b){b.setAttribute('aria-selected',b.dataset.k===k)});
    if(!animate||reduce){paintKind();return}
    swap.classList.add('out');setTimeout(function(){paintKind();swap.classList.remove('out')},220);
  }
  setKind('wedding',false);
  document.querySelectorAll('.tabs button').forEach(function(b){b.addEventListener('click',function(){if(b.dataset.k!==cur)setKind(b.dataset.k,true)})});

  function fillHours(){
    var o='',t='';
    for(var h=cfg.openHour;h<cfg.closeHour;h++)o+='<option value="'+h+'">'+A.fmtHour(h)+'</option>';
    for(var e=cfg.openHour+1;e<=cfg.closeHour;e++)t+='<option value="'+e+'">'+A.fmtHour(e)+'</option>';
    fromSel.innerHTML=o;toSel.innerHTML=t;
    var start=Math.min(Math.max(18,cfg.openHour),cfg.closeHour-cfg.minHours);
    fromSel.value=start;toSel.value=Math.min(cfg.closeHour,start+Math.max(4,cfg.minHours));
  }
  function addMonths(d,n){var x=new Date(d+'T12:00:00Z');x.setUTCMonth(x.getUTCMonth()+n);return x.toISOString().slice(0,10)}

  function month(d){
    var m=d.slice(0,7);
    if(!months[m])months[m]=A.api('GET','/api/availability?month='+m).then(function(r){return r.days}).catch(function(e){delete months[m];throw e});
    return months[m];
  }
  function within(h,ranges){return ranges.some(function(r){return h>=r[0]&&h<r[1]})}

  function setAvail(text,tone){avail.textContent=text;avail.dataset.tone=tone||''}

  // Recompute the strip and the message whenever date or hours change.
  function check(){
    if(!cfg)return;
    var d=date.value,s=+fromSel.value,e=+toSel.value;
    lastCheck=null;
    if(!d){slots.innerHTML='';setAvail('Pick a date to see which hours are open.');return}
    if(d<cfg.today){setAvail('That date has passed.','bad');slots.innerHTML='';return}
    setAvail('Checking…');
    month(d).then(function(days){
      if(date.value!==d)return;
      var day=days[d]||{booked:[],requested:[]},html='',clash=false,asked=false;
      for(var h=cfg.openHour;h<cfg.closeHour;h++){
        var past=d===cfg.today&&h<=cfg.nowHour, booked=within(h,day.booked), req=within(h,day.requested), sel=h>=s&&h<e;
        if(sel&&(booked||past))clash=true;
        if(sel&&req)asked=true;
        var cls=past?'past':booked?'booked':req?'req':'free';
        html+='<span class="slot '+cls+(sel?' sel':'')+'" data-h="'+h+'" title="'+A.fmtHour(h)+'"></span>';
      }
      slots.innerHTML=html+'<span class="slot-l">'+A.fmtHour(cfg.openHour)+'</span><span class="slot-r">'+A.fmtHour(cfg.closeHour)+'</span>';
      var hrs=e-s;
      if(e<=s){setAvail('The end time needs to be after the start.','bad');return}
      if(hrs<cfg.minHours){setAvail('The minimum booking is '+cfg.minHours+' hours.','bad');return}
      if(clash){
        var free=day.booked.map(function(r){return A.fmtHour(r[0])+'–'+A.fmtHour(r[1])}).join(', ');
        setAvail(free?'Taken. Booked on this day: '+free+'.':'Those hours have already started.','bad');return;
      }
      lastCheck={date:d,start:s,end:e};
      var price=A.fmtMoney(cfg.currency,hrs*cfg.hourlyRate);
      setAvail(asked?'Open, but someone has asked for part of this time. About '+price+' for '+hrs+' hours.':'Open. About '+price+' for '+hrs+' hours.','ok');
    }).catch(function(){setAvail("Can't check availability right now. Message us on Instagram instead.",'bad')});
  }
  [date,fromSel,toSel].forEach(function(el){el.addEventListener('change',check)});
  fromSel.addEventListener('change',function(){
    var s=+fromSel.value;if(+toSel.value<=s)toSel.value=Math.min(cfg.closeHour,s+cfg.minHours);check();
  });
  slots.addEventListener('click',function(e){
    var c=e.target.closest('.slot');if(!c||!cfg)return;
    var h=+c.dataset.h,len=Math.max(cfg.minHours,+toSel.value-+fromSel.value);
    fromSel.value=Math.min(h,cfg.closeHour-cfg.minHours);toSel.value=Math.min(cfg.closeHour,+fromSel.value+len);check();
  });

  function saveDraft(){try{sessionStorage.setItem('aveela_draft',JSON.stringify({d:date.value,s:fromSel.value,e:toSel.value,g:guests.value,k:cur,t:pickedType}))}catch(e){}}
  function takeDraft(){try{var v=JSON.parse(sessionStorage.getItem('aveela_draft')||'null');sessionStorage.removeItem('aveela_draft');return v}catch(e){return null}}

  function openRequest(){
    var c=lastCheck;if(!c){check();return}
    var hrs=c.end-c.start,u=A.me;
    var opts=cfg.eventTypes.map(function(t){return '<option'+(t===pickedType?' selected':'')+'>'+A.esc(t)+'</option>'}).join('');
    var m=A.modal(
      '<div class="req"><h2 class="dlg-title">Request this booking</h2><p class="dlg-intro">The venue checks every request. You\'ll get an email when it\'s approved, with payment details.</p>'+
      '<dl class="summary"><dt>Date</dt><dd>'+A.esc(A.fmtDate(c.date,{weekday:'long',month:'long'}))+'</dd><dt>Time</dt><dd>'+A.fmtHour(c.start)+' to '+A.fmtHour(c.end)+' ('+hrs+' hours)</dd>'+
      '<dt>Guests</dt><dd>'+A.esc(guests.value)+'</dd><dt>Estimate</dt><dd>'+A.esc(A.fmtMoney(cfg.currency,hrs*cfg.hourlyRate))+'</dd></dl>'+
      '<form class="form" novalidate><label class="fld"><span>Event</span><select name="eventType">'+opts+'</select></label>'+
      (u&&!u.phone?'<label class="fld"><span>Phone number, so we can reach you</span><input name="phone" type="tel" autocomplete="tel" maxlength="24"></label>':'')+
      '<label class="fld"><span>Anything we should know? (optional)</span><textarea name="notes" maxlength="1000" placeholder="Theme, set-up time, catering, decorations…"></textarea></label>'+
      '<p class="form-err" role="alert"></p><button class="btn btn-gold btn-block" type="submit">Send request</button></form></div>',{label:'Request booking'});
    var form=m.el.querySelector('form'),err=m.el.querySelector('.form-err');
    form.addEventListener('submit',function(e){
      e.preventDefault();err.textContent='';
      var f=Object.fromEntries(new FormData(form));
      var btn=form.querySelector('button');
      A.busy(btn,'Sending…',function(){
        var p=f.phone?A.api('POST','/api/auth/profile',{name:u.name,phone:f.phone}).then(function(r){A.me=r.user}):Promise.resolve();
        return p.then(function(){return A.api('POST','/api/bookings',{eventType:f.eventType,date:c.date,start:c.start,end:c.end,guests:+guests.value,notes:f.notes})});
      }).then(function(r){
        delete months[c.date.slice(0,7)];check();
        m.el.querySelector('.req').innerHTML='<h2 class="dlg-title">Request sent</h2><p class="dlg-intro">Your reference is <strong>'+A.esc(r.booking.ref)+'</strong>. We emailed you a copy and will reply soon. Nothing is charged until the venue approves it.</p>'+
          '<a class="btn btn-primary btn-block" href="/account">View my bookings</a>';
      }).catch(function(ex){err.textContent=ex.message});
    });
  }

  function needVerify(){
    var m=A.modal('<h2 class="dlg-title">Confirm your email first</h2><p class="dlg-intro">We sent a link to <strong>'+A.esc(A.me.email)+'</strong>. Open it, then come back and send your request.</p>'+
      '<p class="form-err" role="alert"></p><button class="btn btn-primary btn-block" type="button">Send the link again</button>',{label:'Confirm email'});
    var b=m.el.querySelector('button.btn');
    b.addEventListener('click',function(){A.busy(b,'Sending…',function(){return A.api('POST','/api/auth/resend-verification')})
      .then(function(){m.el.querySelector('.form-err').textContent='';b.textContent='Sent. Check your inbox';b.disabled=true})
      .catch(function(ex){m.el.querySelector('.form-err').textContent=ex.message})});
  }

  ask.addEventListener('click',function(){
    if(!cfg){setAvail("Online booking isn't available right now. Message us on Instagram.",'bad');return}
    var g=+guests.value;
    if(!date.value){$('dateField').classList.add('bad');date.focus();setAvail('Pick a date first.','bad');return}
    if(!g||g<1||g>cfg.maxGuests){guests.focus();setAvail('Guests must be between 1 and '+cfg.maxGuests+'.','bad');return}
    if(!lastCheck){avail.focus&&avail.focus();return}
    if(!A.me){
      saveDraft();
      A.auth.open({next:'/#book',title:'Sign in to send your request',intro:'Checking dates is open to everyone. To send a request, sign in so we can email you the reply.',
        onDone:function(u){takeDraft();refreshAccountLink();if(!u.verified)needVerify();else openRequest()}});
      return;
    }
    if(!A.me.verified){needVerify();return}
    openRequest();
  });
  date.addEventListener('input',function(){$('dateField').classList.remove('bad')});

  function refreshAccountLink(){
    var l=$('acctLink');if(l)l.textContent=A.me?'My bookings':'Sign in';
  }

  Promise.all([A.loadConfig(),A.loadMe().catch(function(){return null})]).then(function(r){
    cfg=r[0];
    date.min=cfg.today;date.max=addMonths(cfg.today,cfg.monthsAhead);
    guests.max=cfg.maxGuests;
    fillHours();refreshAccountLink();
    // Back from Google/Apple sign-in: restore what they picked and continue.
    var d=takeDraft();
    if(d){date.value=d.d;fromSel.value=d.s;toSel.value=d.e;guests.value=d.g;setKind(d.k,false,d.t)}
    check();
    if(d&&A.me&&d.d){
      setTimeout(function(){
        $('top').scrollIntoView();
        month(d.d).then(function(){setTimeout(function(){if(!A.me.verified)needVerify();else if(lastCheck)openRequest()},60)});
      },reduce?0:3600);
    }
  }).catch(function(){setAvail("Online booking isn't available right now. Message us on Instagram.",'bad')});

  /* event chips and "Check a date" jump to the card */
  function goBook(k,type){
    if(k&&(k!==cur||type))setKind(k,true,type);
    $('top').scrollIntoView({behavior:reduce?'auto':'smooth'});
    setTimeout(function(){date.focus({preventScroll:true})},reduce?0:700);
  }
  document.querySelectorAll('#events button').forEach(function(b){b.addEventListener('click',function(){goBook(b.dataset.k,b.dataset.type)})});
  $('toBook').addEventListener('click',function(e){e.preventDefault();goBook()});
  document.querySelectorAll('.links a[href^="#"]:not(.pill)').forEach(function(a){a.addEventListener('click',function(e){
    var t=document.querySelector(a.getAttribute('href'));if(!t)return;e.preventDefault();t.scrollIntoView({behavior:reduce?'auto':'smooth'});
  })});
})();
