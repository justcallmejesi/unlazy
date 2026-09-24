// ---------- deterministic helpers ----------
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function hex(c){return [parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)];}
function toRGB(c){return typeof c==='string'?hex(c):c;}
function mix(a,b,t){const A=toRGB(a),B=toRGB(b);return [A[0]+(B[0]-A[0])*t,A[1]+(B[1]-A[1])*t,A[2]+(B[2]-A[2])*t];}
function rgb(c,a){return a===undefined?`rgb(${c[0]|0},${c[1]|0},${c[2]|0})`:`rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a})`;}
function cv(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c;}

// smooth value-noise field, progressive x2 upscaling so it stays organic
function noiseField(w,h,cells,seed){
  const rnd=mulberry32(seed);
  let c=cv(cells,cells), x=c.getContext('2d'), id=x.createImageData(cells,cells);
  for(let i=0;i<cells*cells;i++){const v=rnd()*255|0;id.data[i*4]=v;id.data[i*4+1]=v;id.data[i*4+2]=v;id.data[i*4+3]=255;}
  x.putImageData(id,0,0);
  let cw=cells,ch=cells;
  while(cw<w||ch<h){
    const nw=Math.min(w,cw*2), nh=Math.min(h,ch*2);
    const n=cv(nw,nh), nx=n.getContext('2d');
    nx.imageSmoothingEnabled=true; nx.imageSmoothingQuality='high';
    nx.drawImage(c,0,0,nw,nh);
    c=n; cw=nw; ch=nh;
  }
  const px=c.getContext('2d').getImageData(0,0,w,h).data;
  const out=new Float32Array(w*h);
  for(let i=0;i<w*h;i++) out[i]=px[i*4]/255;
  return out;
}
// fractal sum of octaves
function fbm(w,h,seed,octaves){
  const out=new Float32Array(w*h); let amp=1, tot=0, cells=3;
  for(let o=0;o<octaves;o++){
    const f=noiseField(w,h,cells,seed+o*7919);
    for(let i=0;i<w*h;i++) out[i]+=f[i]*amp;
    tot+=amp; amp*=0.52; cells*=2;
  }
  for(let i=0;i<w*h;i++) out[i]/=tot;
  return out;
}
function ramp(v,stops){
  for(let i=0;i<stops.length-1;i++){
    const a=stops[i], b=stops[i+1];
    if(v<=b[0]){ const t=(v-a[0])/Math.max(1e-6,b[0]-a[0]); return mix(a[1],b[1],Math.max(0,Math.min(1,t))); }
  }
  return toRGB(stops[stops.length-1][1]);
}
function vignette(x,w,h,strength,col){
  const g=x.createRadialGradient(w/2,h/2,Math.min(w,h)*0.25,w/2,h/2,Math.max(w,h)*0.72);
  g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,rgb(hex(col),strength));
  x.fillStyle=g; x.fillRect(0,0,w,h);
}

// ---------- photographic sea: CC0 shot, tritone-graded into the brand palette ----------
function makeSeaPhoto(w,h,P,img){
  const c=cv(w,h), x=c.getContext('2d');
  x.drawImage(img,0,0,w,h);
  const d=x.getImageData(0,0,w,h), px=d.data;
  // luminance -> brand ramp. A monotone map, so every bit of photographic detail survives.
  const S=[[0.00,mix(P.ink,'#000000',0.60)],[0.20,mix(P.ink,'#000000',0.30)],
           [0.40,P.ink],[0.58,P.ink2],[0.72,mix(P.ink3,P.goldDeep,0.30)],
           [0.84,P.goldDeep],[0.93,P.gold],[1.00,P.goldLite]];
  // Split tone: luminance sets the base, warmth lifts a pixel up the ramp.
  // Without it the sunset band (mid-luminance but warm) would land on green
  // instead of gold, and the sky would read as just more water.
  const LUT=new Array(1024);
  for(let i=0;i<1024;i++) LUT[i]=ramp(i/1023,S);
  for(let i=0;i<w*h;i++){
    const o=i*4, r=px[o], g=px[o+1], b=px[o+2];
    let v=(r*0.2126+g*0.7152+b*0.0722)/255;
    v=(v-0.5)*1.16+0.54;                                  // S-curve + slight lift
    const warm=Math.max(0,Math.min(1,(r-b)/255*1.7));     // sunset >> cool water
    v=Math.max(0,Math.min(1,v+warm*0.34));
    const col=LUT[(v*1023)|0];
    px[o]=col[0]; px[o+1]=col[1]; px[o+2]=col[2];
  }
  x.putImageData(d,0,0);
  // scrim so the left-aligned quote always holds contrast
  let g=x.createLinearGradient(0,0,w*0.78,h*0.55);
  g.addColorStop(0,rgb(mix(P.ink,'#000000',0.60),0.42));
  g.addColorStop(1,'rgba(0,0,0,0)');
  x.fillStyle=g; x.fillRect(0,0,w,h);
  vignette(x,w,h,0.42,'#000000');
  return c;
}

// ---------- 1. paper: warm cream with fine vertical fibre ----------
function makePaper(w,h,P){
  const c=cv(w,h), x=c.getContext('2d'); const rnd=mulberry32(4242);
  const g=x.createLinearGradient(0,0,w*0.3,h);
  g.addColorStop(0,P.paper); g.addColorStop(0.55,P.paper); g.addColorStop(1,P.paper2);
  x.fillStyle=g; x.fillRect(0,0,w,h);
  // vertical fibres (the reference has ribbed paper texture)
  const dark=mix(P.paper2,P.ink,0.14), lite=mix(P.paper,'#FFFFFF',0.75);
  for(let i=0;i<1500;i++){
    const px=rnd()*w, wd=0.5+rnd()*1.8, up=rnd()>0.5;
    x.strokeStyle=rgb(up?lite:dark,0.05+rnd()*0.10);
    x.lineWidth=wd; x.beginPath();
    let y=-10; x.moveTo(px,y);
    while(y<h+10){ y+=14+rnd()*24; x.lineTo(px+(rnd()-0.5)*1.6,y); }
    x.stroke();
  }
  vignette(x,w,h,0.10,P.ink);
  return c;
}

// ---------- 2. smoke: dark-green ink cloud with gold mist ----------
function makeSmoke(w,h,P){
  const c=cv(w,h), x=c.getContext('2d');
  const f=fbm(w,h,20250920,5);
  const S=[[0.00,P.ink],[0.40,P.ink],[0.58,P.ink2],[0.76,P.ink3],[0.93,P.goldDeep],[1.00,P.gold]];
  const img=x.createImageData(w,h);
  for(let i=0;i<w*h;i++){
    const px=i%w, py=(i/w)|0;
    // push brightness toward the upper-left, like the reference
    const bias=0.13*(1-px/w)+0.08*(1-py/h);
    let v=Math.max(0,Math.min(1,(f[i]-0.34)*1.65+bias));
    const col=ramp(v,S);
    img.data[i*4]=col[0]; img.data[i*4+1]=col[1]; img.data[i*4+2]=col[2]; img.data[i*4+3]=255;
  }
  x.putImageData(img,0,0);
  vignette(x,w,h,0.42,P.ink);
  return c;
}

// ---------- 3. sea: deep green water under a pale gold horizon ----------
function sampler(f,w,h){
  return function(u,v){
    u=Math.abs(u)%2; if(u>1) u=2-u;
    v=Math.abs(v)%2; if(v>1) v=2-v; v=Math.min(0.9999,v);
    const x=u*(w-1), y=v*(h-1);
    const x0=x|0, y0=y|0, x1=Math.min(w-1,x0+1), y1=Math.min(h-1,y0+1);
    const fx=x-x0, fy=y-y0;
    return f[y0*w+x0]*(1-fx)*(1-fy)+f[y0*w+x1]*fx*(1-fy)+f[y1*w+x0]*(1-fx)*fy+f[y1*w+x1]*fx*fy;
  };
}
function makeSea(w,h,P){
  const c=cv(w,h), x=c.getContext('2d');
  const hz=Math.round(h*0.15);            // horizon sits high, as in the reference
  const sunX=w*0.755;
  const S=sampler(fbm(256,256,99991,5),256,256);
  const SC=sampler(fbm(256,256,4242,4),256,256);

  // ---- sky ----
  let g=x.createLinearGradient(0,0,0,hz);
  g.addColorStop(0,rgb(mix(P.ink,'#000000',0.30)));
  g.addColorStop(0.55,rgb(mix(P.ink,P.ink2,0.35)));
  g.addColorStop(1,rgb(mix(P.ink2,P.goldLite,0.34)));
  x.fillStyle=g; x.fillRect(0,0,w,hz+2);
  // stratus cloud streaks: noise squashed hard on the vertical axis
  let img=x.getImageData(0,0,w,hz+2);
  for(let y=0;y<hz+2;y++){
    const t=y/(hz+2);
    for(let px=0;px<w;px++){
      const n=S(px/w*1.6+0.2, t*0.34+0.05);
      const band=Math.pow(Math.max(0,n-0.42)*1.9,1.4)*(0.30+0.85*t);
      if(band<=0) continue;
      const col=mix(P.ink2,P.goldLite,Math.min(1,0.25+t*0.70));
      const i=(y*w+px)*4, k=Math.min(0.62,band);
      img.data[i]  =img.data[i]  *(1-k)+col[0]*k;
      img.data[i+1]=img.data[i+1]*(1-k)+col[1]*k;
      img.data[i+2]=img.data[i+2]*(1-k)+col[2]*k;
    }
  }
  x.putImageData(img,0,0);
  // ---- gold glow behind the horizon ----
  g=x.createRadialGradient(sunX,hz,2,sunX,hz,w*0.46);
  g.addColorStop(0,rgb(hex(P.goldLite),0.75));
  g.addColorStop(0.16,rgb(hex(P.goldLite),0.34));
  g.addColorStop(0.45,rgb(hex(P.gold),0.13));
  g.addColorStop(1,'rgba(0,0,0,0)');
  x.fillStyle=g; x.fillRect(0,0,w,hz+4);

  // ---- water ----
  const wh=h-hz;
  g=x.createLinearGradient(0,hz,0,h);
  g.addColorStop(0,rgb(mix(P.ink2,P.goldDeep,0.30)));
  g.addColorStop(0.14,P.ink2);
  g.addColorStop(0.55,P.ink);
  g.addColorStop(1,rgb(mix(P.ink,'#000000',0.50)));
  x.fillStyle=g; x.fillRect(0,hz,w,wh);

  img=x.getImageData(0,hz,w,wh);
  for(let y=0;y<wh;y++){
    const d=y/wh;                        // 0 at horizon, 1 in the foreground
    const persp=Math.pow(d,1.75);        // perspective compression
    const squash=1.0+d*3.4;              // waves widen as they come closer
    for(let px=0;px<w;px++){
      const u=(px/w)*squash*0.9;
      const n1=S(u+0.11, persp*1.30+0.05);
      const n2=S(u*2.3-0.4, persp*2.10+0.5);
      let crest=(n1-0.5)*1.5+(n2-0.5)*0.9;
      const i=(y*w+px)*4;
      // sun column: gold, strongest at the horizon, spreading as it nears us
      const spread=w*(0.055+0.30*d);
      const sunK=Math.exp(-Math.pow((px-sunX)/spread,2))*(1-Math.pow(d,0.75)*0.90);
      if(crest>0){
        const col=mix(P.ink3,P.goldLite,Math.min(1,sunK*1.9));
        const k=Math.min(0.85,crest*(0.20+0.30*(1-d))+sunK*crest*1.5);
        img.data[i]  =img.data[i]  *(1-k)+col[0]*k;
        img.data[i+1]=img.data[i+1]*(1-k)+col[1]*k;
        img.data[i+2]=img.data[i+2]*(1-k)+col[2]*k;
        // specular sparkle on the very tips of the crests inside the sun column
        if(crest>0.55 && sunK>0.22){
          const s=Math.min(0.9,(crest-0.55)*2.0*sunK*2.2);
          img.data[i]  =img.data[i]  *(1-s)+hex(P.goldLite)[0]*s;
          img.data[i+1]=img.data[i+1]*(1-s)+hex(P.goldLite)[1]*s;
          img.data[i+2]=img.data[i+2]*(1-s)+hex(P.goldLite)[2]*s;
        }
      } else {
        const k=Math.min(0.55,-crest*(0.18+0.34*d));
        const col=mix(P.ink,'#000000',0.55);
        img.data[i]  =img.data[i]  *(1-k)+col[0]*k;
        img.data[i+1]=img.data[i+1]*(1-k)+col[1]*k;
        img.data[i+2]=img.data[i+2]*(1-k)+col[2]*k;
      }
    }
  }
  x.putImageData(img,0,hz);
  // soften the horizon seam
  g=x.createLinearGradient(0,hz-5,0,hz+9);
  g.addColorStop(0,rgb(mix(P.ink2,P.goldLite,0.28),0)); 
  g.addColorStop(0.5,rgb(mix(P.ink2,P.goldLite,0.28),0.30));
  g.addColorStop(1,rgb(mix(P.ink2,P.goldLite,0.28),0));
  x.fillStyle=g; x.fillRect(0,hz-5,w,14);
  // scrim so the left-aligned quote always holds contrast
  g=x.createLinearGradient(0,0,w*0.72,h*0.5);
  g.addColorStop(0,rgb(mix(P.ink,'#000000',0.55),0.50));
  g.addColorStop(1,'rgba(0,0,0,0)');
  x.fillStyle=g; x.fillRect(0,hz,w,h-hz);

  // ---- foreground rock, lower right (echoes the reference framing) ----
  const rockTop=y=>{
    const t=(w-y)/(w*0.72);
    return h*0.50+Math.pow(Math.max(0,t),1.6)*h*0.95;
  };
  x.beginPath(); x.moveTo(w,h); x.lineTo(w,h*0.485);
  for(let px=w;px>=w*0.26;px-=4){
    const jag=(SC(px/w*3.1,0.7)-0.5)*30+(SC(px/w*9.0,0.2)-0.5)*11;
    x.lineTo(px, rockTop(px)+jag);
  }
  x.lineTo(w*0.26,h); x.closePath();
  const rock=x.fillStyle=rgb(mix(P.ink,'#000000',0.62)); x.fill();
  x.save(); x.clip();
  g=x.createLinearGradient(w*0.30,h*0.55,w*0.95,h);
  g.addColorStop(0,rgb(hex(P.goldDeep),0.20)); g.addColorStop(0.45,'rgba(0,0,0,0)');
  x.fillStyle=g; x.fillRect(0,0,w,h);
  x.restore();

  // ---- seated figure on the rock, backlit ----
  const fx=w*0.760, base=rockTop(fx)-4, fh=78, s=fh/100;
  x.save(); x.translate(fx,base); x.scale(s,s);
  x.fillStyle=rgb(mix(P.ink,'#000000',0.80));
  x.beginPath();
  x.moveTo(-30,0);                                    // hem of the shawl, left
  x.bezierCurveTo(-34,-26,-26,-44,-16,-52);           // back
  x.bezierCurveTo(-14,-66,-8,-74,0,-74);              // neck
  x.bezierCurveTo(10,-74,15,-66,14,-53);              // far shoulder
  x.bezierCurveTo(26,-45,33,-26,31,0);                // front of the knees
  x.closePath(); x.fill();
  x.beginPath(); x.ellipse(1,-82,12.5,13.5,0.06,0,Math.PI*2); x.fill();   // head
  x.beginPath();                                       // long hair down the back
  x.moveTo(-11,-86);
  x.bezierCurveTo(-21,-78,-24,-62,-20,-48);
  x.bezierCurveTo(-13,-52,-8,-62,-8,-78);
  x.closePath(); x.fill();
  x.restore();
  // rim light on the sun side of the figure
  x.save(); x.translate(fx,base); x.scale(s,s);
  x.strokeStyle=rgb(hex(P.goldLite),0.34); x.lineWidth=2.0;
  x.beginPath();
  x.moveTo(-30,0);
  x.bezierCurveTo(-34,-26,-26,-44,-16,-52);
  x.bezierCurveTo(-14,-66,-8,-74,0,-74);
  x.stroke();
  x.beginPath(); x.ellipse(1,-82,12.5,13.5,0.06,Math.PI*0.62,Math.PI*1.55); x.stroke();
  x.restore();

  vignette(x,w,h,0.52,'#000000');
  return c;
}

// ---------- 4. grain ----------
function makeGrain(w,h){
  const c=cv(w,h), x=c.getContext('2d'); const rnd=mulberry32(31337);
  const img=x.createImageData(w,h);
  for(let i=0;i<w*h;i++){const v=rnd()*255|0;img.data[i*4]=v;img.data[i*4+1]=v;img.data[i*4+2]=v;img.data[i*4+3]=255;}
  x.putImageData(img,0,0); return c;
}

// ---------- thread overlay ----------
// The reference frame is a hand holding a red thread that runs off across a
// meadow. No free-licence photograph of that exists in the sources this session
// can reach, and a drawn hand reads as a pasted silhouette against real grass —
// so the thread runs in from off-frame and the hand is left to the viewer.
// It is kept below y=0.5 so it never crosses the quote.
function drawThread(c, P){
  const x = c.getContext('2d'), W = c.width, H = c.height;
  const lw = Math.max(2.4, W * 0.0026);

  // two strands converging to a point just off the right edge, sagging left
  function strand(d, alpha, width){
    x.beginPath();
    x.moveTo(W * 1.04, H * 0.545);
    x.bezierCurveTo(W * 0.66, H * (0.60 + d.c1),
                    W * 0.32, H * (0.79 + d.c2),
                    -W * 0.03, H * (0.86 + d.end));
    x.strokeStyle = rgb(hex(P.goldLite), alpha);
    x.lineWidth = width; x.lineCap = 'round';
    x.stroke();
  }
  x.save();
  x.shadowColor = rgb(hex(P.gold), 0.60);
  x.shadowBlur  = W * 0.007;
  strand({c1: 0.00, c2: 0.00, end: 0.00}, 0.94, lw);
  strand({c1: 0.10, c2: 0.06, end: -0.04}, 0.76, lw * 0.82);
  x.restore();
  return c;
}
