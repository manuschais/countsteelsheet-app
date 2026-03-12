import { useRef, useState, useCallback, useEffect } from 'react'

/* ─── design tokens ──────────────────────────────────────────────── */
const C = {
  bg: '#0f172a', surface: '#1e293b', border: '#334155',
  accent: '#60a5fa', accent2: '#818cf8', muted: '#94a3b8',
  orange: '#f97316', teal: '#0891b2', red: '#ef4444', green: '#4ade80',
}

/* ─── 1-D signal helpers (pure JS, no OpenCV) ────────────────────── */
function gaussianSmooth(arr, sigma) {
  if (sigma <= 0) return [...arr]
  const r = Math.ceil(sigma * 2.5)
  const kernel = []
  let ksum = 0
  for (let i = -r; i <= r; i++) {
    const w = Math.exp(-0.5 * (i / sigma) ** 2)
    kernel.push(w); ksum += w
  }
  const k = kernel.map(w => w / ksum)
  return arr.map((_, i) => {
    let v = 0
    for (let j = 0; j < k.length; j++) {
      const idx = Math.max(0, Math.min(arr.length - 1, i + j - r))
      v += arr[idx] * k[j]
    }
    return v
  })
}

function findPeaks(profile, minDist, minHeightPct) {
  const maxVal = Math.max(...profile)
  if (maxVal === 0) return []
  const thresh = maxVal * minHeightPct / 100

  // collect local maxima above threshold
  const cands = []
  for (let i = 1; i < profile.length - 1; i++) {
    if (profile[i] >= thresh &&
        profile[i] >= profile[i - 1] &&
        profile[i] >= profile[i + 1]) {
      cands.push({ y: i, v: profile[i] })
    }
  }

  // non-maximum suppression: greedy, highest first
  cands.sort((a, b) => b.v - a.v)
  const peaks = []
  for (const c of cands) {
    if (!peaks.some(p => Math.abs(c.y - p) < minDist)) peaks.push(c.y)
  }
  return peaks.sort((a, b) => a - b)
}

/* ─── small UI atoms ─────────────────────────────────────────────── */
function Btn({ children, onClick, active, color = C.accent, disabled, style = {} }) {
  return (
    <button
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '9px 18px', border: `1.5px solid ${active ? color : C.border}`,
        borderRadius: 8, fontSize: '0.9rem', fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.42 : 1,
        background: active ? color : C.surface, color: active ? '#fff' : C.muted,
        userSelect: 'none', transition: 'opacity .15s', ...style,
      }}
      onClick={onClick} disabled={disabled}
    >{children}</button>
  )
}

function Slider({ label, value, min, max, step = 1, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '0.75rem', color: C.muted, fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: '0.75rem', color: C.accent, fontWeight: 700 }}>{value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: C.accent }} />
    </div>
  )
}

function Section({ title, children }) {
  return (
    <details style={{ width: '100%', maxWidth: 720, background: C.surface,
                      borderRadius: 10, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
      <summary style={{ padding: '10px 16px', fontSize: '0.88rem', fontWeight: 600,
                        color: C.accent, cursor: 'pointer', userSelect: 'none', listStyle: 'none',
                        display: 'flex', alignItems: 'center', gap: 8 }}>
        ▶ {title}
      </summary>
      <div style={{ padding: '0 16px 16px', display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 12 }}>
        {children}
      </div>
    </details>
  )
}

/* ─── modes ──────────────────────────────────────────────────────── */
const MODES = [
  { id: 'cv',        label: 'CV HoughLines' },
  { id: 'yprofile',  label: 'Y-Projection ✨' },
  { id: 'thickness', label: 'วัดความหนา' },
]

/* ════════════════════════════════════════════════════════════════════
   Main App
═══════════════════════════════════════════════════════════════════ */
export default function App() {
  /* image */
  const [imageData, setImageData] = useState(null)

  /* mode */
  const [mode, setMode] = useState('yprofile')

  /* zoom / pan */
  const [zoom, setZoom]   = useState(1)
  const [pan,  setPan]    = useState({ x: 0, y: 0 })

  /* manual count */
  const [manualMode,  setManualMode]  = useState(false)
  const [manualDots,  setManualDots]  = useState([])
  const [autoCount,   setAutoCount]   = useState(0)
  const [dotSize,     setDotSize]     = useState(1.0)

  /* clusters — shared by CV and Y-profile (same shape: {avgY, lines, ox, removed}) */
  const [clusters,    setClusters]    = useState([])
  const [badgeSize,   setBadgeSize]   = useState(1.0)
  const [showLines,   setShowLines]   = useState(false)

  /* Y-profile specific */
  const [profileData, setProfileData] = useState([])   // normalised 0-1 per row
  const [yParams, setYParams] = useState({
    blur: 5, cannyLow: 50, cannyHigh: 150,
    smooth: 8, minHeight: 15, minDist: 20,
  })

  /* CV params */
  const [cvParams, setCvParams] = useState({
    blur: 5, cannyLow: 50, cannyHigh: 150,
    minLen: 25, tolerance: 20, maxGap: 20,
  })

  /* image adjustments */
  const [brightness,  setBrightness]  = useState(0)
  const [contrast,    setContrast]    = useState(0)
  const [rotation,    setRotation]    = useState(0)
  const [falseColor,  setFalseColor]  = useState(false)

  /* roi */
  const [roi,     setRoi]     = useState(null)
  const [roiMode, setRoiMode] = useState(false)
  const roiStartRef = useRef(null)
  const roiDragRef  = useRef(null)

  /* status */
  const [status, setStatus] = useState({ msg: 'โหลดภาพเพื่อเริ่มต้น', type: 'info' })
  const [result, setResult] = useState(null)

  /* refs */
  const canvasRef     = useRef(null)
  const hiddenFileRef = useRef(null)
  const hiddenCamRef  = useRef(null)
  const panningRef    = useRef(false)
  const panStartRef   = useRef(null)
  const pinchRef      = useRef(null)

  const total = autoCount + manualDots.length

  /* ── load image ── */
  const loadFile = useCallback((file) => {
    if (!file) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const cv = canvasRef.current
      cv.width = img.naturalWidth; cv.height = img.naturalHeight
      cv.getContext('2d').drawImage(img, 0, 0)
      setImageData(cv.getContext('2d').getImageData(0, 0, cv.width, cv.height))
      setManualDots([]); setAutoCount(0); setClusters([])
      setRoi(null); setResult(null); setProfileData([])
      setZoom(1); setPan({ x: 0, y: 0 })
      setStatus({ msg: `โหลดสำเร็จ: ${cv.width}×${cv.height}px`, type: 'ok' })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => setStatus({ msg: 'โหลดภาพไม่สำเร็จ', type: 'error' })
    img.src = url
  }, [])

  /* ── pixel helpers ── */
  const getAdjusted = useCallback((src) => {
    if (brightness === 0 && contrast === 0) return src
    const out = new ImageData(src.width, src.height)
    const s = src.data, d = out.data, c = 1 + contrast / 100
    for (let i = 0; i < s.length; i += 4) {
      for (let ch = 0; ch < 3; ch++) {
        let v = (s[i + ch] - 128) * c + 128 + brightness
        d[i + ch] = Math.max(0, Math.min(255, Math.round(v)))
      }
      d[i + 3] = s[i + 3]
    }
    return out
  }, [brightness, contrast])

  /* returns ImageData after brightness/contrast + rotation applied */
  const getTransformed = useCallback((src) => {
    const adj = getAdjusted(src)
    if (rotation === 0) return adj
    const rad = rotation * Math.PI / 180
    const tmp = document.createElement('canvas')
    tmp.width = src.width; tmp.height = src.height
    const ctx = tmp.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, tmp.width, tmp.height)
    // put adjusted image into an offscreen canvas to drawImage from
    const off = document.createElement('canvas')
    off.width = src.width; off.height = src.height
    off.getContext('2d').putImageData(adj, 0, 0)
    ctx.translate(src.width / 2, src.height / 2)
    ctx.rotate(rad)
    ctx.drawImage(off, -src.width / 2, -src.height / 2)
    return ctx.getImageData(0, 0, tmp.width, tmp.height)
  }, [getAdjusted, rotation])

  /* ── draw loop ── */
  useEffect(() => {
    if (!imageData) return
    const canvas = canvasRef.current
    const ctx    = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height

    /* base */
    ctx.putImageData(getTransformed(imageData), 0, 0)

    /* false color */
    if (falseColor) {
      const id = ctx.getImageData(0, 0, W, H), d = id.data
      for (let i = 0; i < d.length; i += 4) {
        const g = (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]) / 255
        let r, gr, b
        if      (g < 0.25) { r=0;              gr=g*4*255;      b=255 }
        else if (g < 0.5)  { r=0;              gr=255;          b=(0.5-g)*4*255 }
        else if (g < 0.75) { r=(g-0.5)*4*255;  gr=255;          b=0 }
        else               { r=255;             gr=(1-g)*4*255;  b=0 }
        d[i]=Math.round(r); d[i+1]=Math.round(gr); d[i+2]=Math.round(b)
      }
      ctx.putImageData(id, 0, 0)
    }

    /* ROI */
    const drawRoi = roi || (roiStartRef.current && roiDragRef.current
      ? normalizeRect(roiStartRef.current, roiDragRef.current) : null)
    if (drawRoi) {
      ctx.save()
      ctx.strokeStyle='#22d3ee'; ctx.lineWidth=Math.max(2,W/500)
      ctx.setLineDash([10,5])
      ctx.strokeRect(drawRoi.x, drawRoi.y, drawRoi.w, drawRoi.h)
      ctx.fillStyle='rgba(34,211,238,0.07)'
      ctx.fillRect(drawRoi.x, drawRoi.y, drawRoi.w, drawRoi.h)
      ctx.restore()
    }

    /* Y-profile chart */
    if ((mode === 'yprofile') && profileData.length > 0) {
      const chartW = Math.min(80, W * 0.12)
      const cx0    = W - chartW
      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(cx0, 0, chartW, H)
      for (let y = 0; y < Math.min(profileData.length, H); y++) {
        const v = profileData[y]
        const barW = v * chartW
        // color: low=blue, high=red
        const hue = (1 - v) * 240
        ctx.fillStyle = `hsla(${hue},90%,55%,0.75)`
        ctx.fillRect(cx0, y, barW, 1)
      }
      ctx.restore()
    }

    /* cluster badges & lines */
    if ((mode === 'cv' || mode === 'yprofile') && clusters.length > 0) {
      const lw = Math.max(2, W/500)
      const br = Math.max(14, W/65) * badgeSize
      let visIdx = 0
      clusters.forEach(cl => {
        const lx = cl.ox + br + 4, ly = Math.round(cl.avgY)
        ctx.save()
        if (cl.removed) {
          if (showLines && cl.lines.length) {
            ctx.globalAlpha=0.18; ctx.strokeStyle='#aaa'; ctx.lineWidth=lw
            cl.lines.forEach(l=>{ctx.beginPath();ctx.moveTo(l.x1,l.y1);ctx.lineTo(l.x2,l.y2);ctx.stroke()})
            ctx.globalAlpha=1
          }
          ctx.fillStyle='rgba(150,150,150,0.45)'
          ctx.beginPath(); ctx.arc(lx,ly,br,0,Math.PI*2); ctx.fill()
          ctx.strokeStyle='#e94560'; ctx.lineWidth=Math.max(2,br*0.18)
          ctx.beginPath(); ctx.moveTo(lx-br*0.6,ly-br*0.6); ctx.lineTo(lx+br*0.6,ly+br*0.6); ctx.stroke()
        } else {
          visIdx++
          if (showLines && cl.lines.length) {
            ctx.strokeStyle='#ff3333'; ctx.lineWidth=lw
            cl.lines.forEach(l=>{ctx.beginPath();ctx.moveTo(l.x1,l.y1);ctx.lineTo(l.x2,l.y2);ctx.stroke()})
          }
          /* for Y-profile: draw a horizontal tick line across image */
          if (mode === 'yprofile') {
            ctx.strokeStyle='rgba(250,204,0,0.55)'; ctx.lineWidth=Math.max(1,lw*0.7)
            ctx.setLineDash([8,4])
            ctx.beginPath(); ctx.moveTo(0,ly); ctx.lineTo(W,ly); ctx.stroke()
            ctx.setLineDash([])
          }
          ctx.fillStyle='#ffc800'
          ctx.beginPath(); ctx.arc(lx,ly,br,0,Math.PI*2); ctx.fill()
          ctx.fillStyle='#000'; ctx.font=`bold ${Math.round(br*1.05)}px sans-serif`
          ctx.textAlign='center'; ctx.textBaseline='middle'
          ctx.fillText(String(visIdx), lx, ly)
        }
        ctx.restore()
      })
    }

    /* manual dots */
    manualDots.forEach(d => {
      const r = Math.max(14, W/65) * dotSize
      ctx.save()
      ctx.fillStyle=C.orange; ctx.beginPath(); ctx.arc(d.cx,d.cy,r,0,Math.PI*2); ctx.fill()
      ctx.strokeStyle='#fff'; ctx.lineWidth=Math.max(2,r*0.12); ctx.stroke()
      ctx.fillStyle='#fff'; ctx.font=`bold ${Math.round(r*1.05)}px sans-serif`
      ctx.textAlign='center'; ctx.textBaseline='middle'
      ctx.fillText(String(d.n), d.cx, d.cy)
      ctx.restore()
    })
  }, [imageData, brightness, contrast, rotation, falseColor, roi, mode, clusters, showLines,
      badgeSize, manualDots, dotSize, profileData, getTransformed])

  /* ── coord helper ── */
  const toCanvas = useCallback((cx, cy) => {
    const r = canvasRef.current.getBoundingClientRect()
    return {
      x: Math.round((cx - r.left) * canvasRef.current.width  / r.width),
      y: Math.round((cy - r.top)  * canvasRef.current.height / r.height),
    }
  }, [])

  function normalizeRect(a, b) {
    return { x:Math.min(a.x,b.x), y:Math.min(a.y,b.y),
             w:Math.abs(b.x-a.x), h:Math.abs(b.y-a.y) }
  }

  /* ── pointer events ── */
  const onPointerDown = useCallback((e) => {
    if (!imageData) return
    e.preventDefault()
    const pt = toCanvas(e.clientX, e.clientY)

    /* right-click = pan */
    if (e.button === 2) {
      panningRef.current = true
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    /* ROI drag */
    if (roiMode) {
      roiStartRef.current = pt; roiDragRef.current = pt
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    /* badge removal */
    const br = Math.max(14, canvasRef.current.width/65) * badgeSize
    if ((mode==='cv'||mode==='yprofile') && clusters.length > 0) {
      const hit = clusters.find(cl => {
        const lx=cl.ox+br+4, ly=Math.round(cl.avgY)
        return (pt.x-lx)**2+(pt.y-ly)**2 <= br*br
      })
      if (hit) {
        const upd = clusters.map(cl => cl===hit ? {...cl,removed:!cl.removed} : cl)
        setClusters(upd)
        const na = upd.filter(c=>!c.removed).length
        setAutoCount(na); setResult(na + manualDots.length)
        return
      }
    }
    /* manual tap */
    if (manualMode) {
      const n = autoCount + manualDots.length + 1
      setManualDots(prev => [...prev, {cx:pt.x,cy:pt.y,n}])
      setResult(autoCount + manualDots.length + 1)
      return
    }
    /* pan when zoomed */
    if (zoom > 1) {
      panningRef.current = true
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  }, [imageData, pan, roiMode, mode, clusters, badgeSize, manualMode, autoCount, manualDots, zoom, toCanvas])

  const onPointerMove = useCallback((e) => {
    if (panningRef.current && panStartRef.current) {
      const wrap = e.currentTarget.parentElement
      const maxPx = wrap.clientWidth  * (zoom-1)/2
      const maxPy = wrap.clientHeight * (zoom-1)/2
      setPan({
        x: Math.max(-maxPx, Math.min(maxPx, e.clientX - panStartRef.current.x)),
        y: Math.max(-maxPy, Math.min(maxPy, e.clientY - panStartRef.current.y)),
      })
    }
    if (roiMode && roiStartRef.current) {
      roiDragRef.current = toCanvas(e.clientX, e.clientY)
      // trigger redraw via a dummy state — handled by draw effect already watching roi
      setRoi(r => r)   // force re-eval — use a ref-based approach below
    }
  }, [zoom, roiMode, toCanvas])

  const onPointerUp = useCallback((e) => {
    if (panningRef.current) { panningRef.current = false; panStartRef.current = null }
    if (roiMode && roiStartRef.current && roiDragRef.current) {
      const r = normalizeRect(roiStartRef.current, roiDragRef.current)
      if (r.w > 15 && r.h > 15) setRoi(r)
      roiStartRef.current = null; roiDragRef.current = null
      setRoiMode(false)
    }
  }, [roiMode])

  const onContextMenu = useCallback(e => e.preventDefault(), [])

  /* ── wheel zoom ── */
  const onWheel = useCallback((e) => {
    e.preventDefault()
    const wr = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - wr.left - wr.width  / 2
    const my = e.clientY - wr.top  - wr.height / 2
    setZoom(prev => {
      const next  = Math.max(1, Math.min(6, prev * (e.deltaY>0 ? 0.88 : 1.14)))
      const ratio = next / prev
      setPan(p => {
        const mpx = wr.width*(next-1)/2, mpy = wr.height*(next-1)/2
        return {
          x: Math.max(-mpx, Math.min(mpx, mx*(1-ratio)+p.x*ratio)),
          y: Math.max(-mpy, Math.min(mpy, my*(1-ratio)+p.y*ratio)),
        }
      })
      return next
    })
  }, [])

  /* ── CV: HoughLinesP ── */
  const processCv = useCallback(() => {
    if (typeof cv === 'undefined') { setStatus({msg:'OpenCV ยังไม่โหลด',type:'error'}); return }
    if (!imageData) return
    setStatus({msg:'กำลังประมวลผล CV...',type:'info'})

    setTimeout(() => {
      let fullSrc, procSrc, gray, blurred, edges, lines
      try {
        const canvas = canvasRef.current
        canvas.getContext('2d').putImageData(getTransformed(imageData), 0, 0)
        fullSrc = cv.imread(canvas)

        let ox=0, oy=0
        if (roi && roi.w>20 && roi.h>20) {
          const rx=Math.max(0,Math.min(roi.x,fullSrc.cols-2))
          const ry=Math.max(0,Math.min(roi.y,fullSrc.rows-2))
          const rw=Math.min(roi.w,fullSrc.cols-rx), rh=Math.min(roi.h,fullSrc.rows-ry)
          if (rw>10&&rh>10){ procSrc=fullSrc.roi(new cv.Rect(rx,ry,rw,rh)).clone(); ox=rx; oy=ry }
        }
        if (!procSrc) procSrc = fullSrc.clone()

        let k = cvParams.blur % 2===0 ? cvParams.blur+1 : cvParams.blur
        gray=new cv.Mat(); blurred=new cv.Mat(); edges=new cv.Mat()
        cv.cvtColor(procSrc,gray,cv.COLOR_RGBA2GRAY)
        cv.GaussianBlur(gray,blurred,new cv.Size(k,k),0)
        cv.Canny(blurred,edges,cvParams.cannyLow,cvParams.cannyHigh)

        lines=new cv.Mat()
        const refW = roi ? Math.min(roi.w,procSrc.cols) : canvas.width
        cv.HoughLinesP(edges,lines,1,Math.PI/180,40,refW*cvParams.minLen/100,cvParams.maxGap)

        const horiz=[]
        for(let i=0;i<lines.rows;i++){
          const x1=lines.data32S[i*4]+ox, y1=lines.data32S[i*4+1]+oy
          const x2=lines.data32S[i*4+2]+ox, y2=lines.data32S[i*4+3]+oy
          const ang=Math.abs(Math.atan2(y2-y1,x2-x1)*180/Math.PI)
          if(ang<15||ang>165) horiz.push({x1,y1,x2,y2,midY:(y1+y2)/2})
        }
        horiz.sort((a,b)=>a.midY-b.midY)

        const cl=[]
        for(const ln of horiz){
          const last=cl[cl.length-1]
          if(!last||ln.midY-last.avgY>cvParams.tolerance) cl.push({lines:[ln],avgY:ln.midY})
          else{ last.lines.push(ln); last.avgY=last.lines.reduce((s,l)=>s+l.midY,0)/last.lines.length }
        }

        const newCl = cl.map(c=>({
          lines: c.lines.map(l=>({x1:l.x1,y1:l.y1,x2:l.x2,y2:l.y2})),
          avgY:c.avgY, ox, removed:false,
        }))
        setClusters(newCl); setAutoCount(newCl.length)
        setManualDots([]); setResult(newCl.length); setProfileData([])
        setStatus({msg:`CV: พบ ${newCl.length} กลุ่มเส้น จาก ${horiz.length} เส้น`,type:'ok'})
      } catch(err){ setStatus({msg:'ผิดพลาด: '+err.message,type:'error'}) }
      finally{ [fullSrc,procSrc,gray,blurred,edges,lines].forEach(m=>{try{if(m&&!m.isDeleted())m.delete()}catch(_){}}) }
    },50)
  }, [imageData, roi, cvParams])

  /* ── Y-PROJECTION ── */
  const processYProfile = useCallback(() => {
    if (typeof cv === 'undefined') { setStatus({msg:'OpenCV ยังไม่โหลด',type:'error'}); return }
    if (!imageData) return
    setStatus({msg:'กำลังคำนวณ Y-Projection...',type:'info'})

    setTimeout(() => {
      let fullSrc, procSrc, gray, blurred, edges
      try {
        const canvas = canvasRef.current
        canvas.getContext('2d').putImageData(getTransformed(imageData), 0, 0)
        fullSrc = cv.imread(canvas)

        let ox=0, oy=0, procH=fullSrc.rows
        if (roi && roi.w>20 && roi.h>20) {
          const rx=Math.max(0,Math.min(roi.x,fullSrc.cols-2))
          const ry=Math.max(0,Math.min(roi.y,fullSrc.rows-2))
          const rw=Math.min(roi.w,fullSrc.cols-rx), rh=Math.min(roi.h,fullSrc.rows-ry)
          if(rw>10&&rh>10){ procSrc=fullSrc.roi(new cv.Rect(rx,ry,rw,rh)).clone(); ox=rx; oy=ry; procH=rh }
        }
        if (!procSrc) procSrc = fullSrc.clone()

        let k = yParams.blur % 2===0 ? yParams.blur+1 : yParams.blur
        gray=new cv.Mat(); blurred=new cv.Mat(); edges=new cv.Mat()
        cv.cvtColor(procSrc,gray,cv.COLOR_RGBA2GRAY)
        cv.GaussianBlur(gray,blurred,new cv.Size(k,k),0)
        cv.Canny(blurred,edges,yParams.cannyLow,yParams.cannyHigh)

        /* ── Y-projection: sum edge pixels per row ── */
        const rawProfile = new Float32Array(procH)
        const eData = edges.data          // Uint8Array, 1-channel (after Canny)
        const eW    = edges.cols
        for (let y = 0; y < procH; y++) {
          let sum = 0
          const rowBase = y * eW
          for (let x = 0; x < eW; x++) sum += eData[rowBase + x]
          rawProfile[y] = sum / (eW * 255)   // normalise 0-1
        }

        /* ── smooth ── */
        const smoothed = gaussianSmooth(Array.from(rawProfile), yParams.smooth)

        /* ── peak detection ── */
        const peakRows = findPeaks(smoothed, yParams.minDist, yParams.minHeight)

        /* ── build full-image profile (for display) ── */
        const fullProfile = new Array(canvas.height).fill(0)
        const maxS = Math.max(...smoothed, 1e-9)
        smoothed.forEach((v, i) => { fullProfile[oy + i] = v / maxS })
        setProfileData(fullProfile)

        /* ── convert peaks to cluster format ── */
        const newCl = peakRows.map(py => ({
          lines: [],          // no line segments for Y-profile
          avgY:  oy + py,
          ox,
          removed: false,
        }))
        setClusters(newCl); setAutoCount(newCl.length)
        setManualDots([]); setResult(newCl.length)
        setStatus({msg:`Y-Projection: พบ ${newCl.length} ขอบแผ่น (peaks)`,type:'ok'})
      } catch(err){ setStatus({msg:'ผิดพลาด: '+err.message,type:'error'}) }
      finally{ [fullSrc,procSrc,gray,blurred,edges].forEach(m=>{try{if(m&&!m.isDeleted())m.delete()}catch(_){}}) }
    },50)
  }, [imageData, roi, yParams])

  const handleProcess = useCallback(() => {
    if (mode === 'cv') processCv()
    else if (mode === 'yprofile') processYProfile()
  }, [mode, processCv, processYProfile])

  const handleReset = () => {
    setImageData(null); setClusters([]); setManualDots([])
    setAutoCount(0); setResult(null); setZoom(1); setPan({x:0,y:0})
    setProfileData([]); setRoi(null)
    setStatus({msg:'รีเซ็ตแล้ว',type:'info'})
  }

  /* ════════════════════ RENDER ════════════════════ */
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center',
                  minHeight:'100%', padding:'20px 16px', gap:14 }}>

      {/* Header */}
      <header style={{ textAlign:'center' }}>
        <h1 style={{ fontSize:'1.5rem', fontWeight:800,
                     background:'linear-gradient(135deg,#60a5fa,#818cf8)',
                     WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent',
                     backgroundClip:'text' }}>
          ระบบนับแผ่นเหล็ก <span style={{fontSize:'0.7em',opacity:0.7}}>รุ่น 2</span>
        </h1>
        <a href="../" style={{fontSize:'0.75rem',color:C.muted,textDecoration:'none'}}>
          ← กลับหน้าหลัก
        </a>
      </header>

      {/* Buttons */}
      <div style={{display:'flex',gap:10,flexWrap:'wrap',justifyContent:'center'}}>
        <input ref={hiddenCamRef} type="file" accept="image/*" capture="environment"
               style={{display:'none'}} onChange={e=>loadFile(e.target.files[0])} />
        <input ref={hiddenFileRef} type="file" accept="image/*"
               style={{display:'none'}} onChange={e=>loadFile(e.target.files[0])} />
        <Btn onClick={()=>hiddenCamRef.current.click()}  style={{background:'#0f3460',color:'#fff',border:'none'}}>📷 ถ่ายภาพ</Btn>
        <Btn onClick={()=>hiddenFileRef.current.click()} style={{background:'#e94560',color:'#fff',border:'none'}}>⬆️ อัปโหลด</Btn>
        {imageData && mode !== 'thickness' && (
          <Btn onClick={handleProcess} style={{background:'#1e3a5f',color:'#93c5fd',border:'1.5px solid #1e40af'}}>
            ⚙️ {mode==='yprofile' ? 'คำนวณ Y-Profile' : 'ประมวลผล CV'}
          </Btn>
        )}
        {imageData && (
          <Btn onClick={handleReset} style={{background:C.surface,color:C.muted}}>รีเซ็ต</Btn>
        )}
      </div>

      {/* Mode tabs */}
      <div style={{display:'flex',width:'100%',maxWidth:720,background:C.surface,
                   borderRadius:10,overflow:'hidden',border:`1px solid ${C.border}`}}>
        {MODES.map(m => (
          <button key={m.id} onClick={()=>setMode(m.id)} style={{
            flex:1, padding:'11px 4px', border:'none', cursor:'pointer',
            background: mode===m.id ? '#1e3a5f' : 'transparent',
            color: mode===m.id ? C.accent : C.muted, fontWeight:600, fontSize:'0.82rem',
            borderBottom: mode===m.id ? `3px solid ${C.accent}` : '3px solid transparent',
            transition:'all .2s',
          }}>{m.label}</button>
        ))}
      </div>

      {/* Y-Profile params */}
      {mode === 'yprofile' && (
        <Section title="ปรับพารามิเตอร์ Y-Projection">
          <Slider label="Blur kernel"    value={yParams.blur}      min={1}  max={15} step={2} onChange={v=>setYParams(p=>({...p,blur:v}))} />
          <Slider label="Canny low"      value={yParams.cannyLow}  min={5}  max={150} step={5} onChange={v=>setYParams(p=>({...p,cannyLow:v}))} />
          <Slider label="Canny high"     value={yParams.cannyHigh} min={50} max={400} step={10} onChange={v=>setYParams(p=>({...p,cannyHigh:v}))} />
          <Slider label="Smoothing σ"    value={yParams.smooth}    min={0}  max={30} step={1} onChange={v=>setYParams(p=>({...p,smooth:v}))} />
          <Slider label="Min peak height %" value={yParams.minHeight} min={3} max={60} step={1} onChange={v=>setYParams(p=>({...p,minHeight:v}))} />
          <Slider label="Min peak dist px"  value={yParams.minDist}   min={3} max={100} step={1} onChange={v=>setYParams(p=>({...p,minDist:v}))} />
        </Section>
      )}

      {/* CV params */}
      {mode === 'cv' && (
        <Section title="ปรับพารามิเตอร์ CV HoughLines">
          <Slider label="Blur kernel"        value={cvParams.blur}       min={1}  max={15} step={2}  onChange={v=>setCvParams(p=>({...p,blur:v}))} />
          <Slider label="Canny low"          value={cvParams.cannyLow}   min={5}  max={150} step={5} onChange={v=>setCvParams(p=>({...p,cannyLow:v}))} />
          <Slider label="Canny high"         value={cvParams.cannyHigh}  min={50} max={400} step={10} onChange={v=>setCvParams(p=>({...p,cannyHigh:v}))} />
          <Slider label="Min line length %"  value={cvParams.minLen}     min={5}  max={80} step={5}  onChange={v=>setCvParams(p=>({...p,minLen:v}))} />
          <Slider label="Cluster tolerance"  value={cvParams.tolerance}  min={5}  max={60} step={5}  onChange={v=>setCvParams(p=>({...p,tolerance:v}))} />
          <Slider label="Max line gap"       value={cvParams.maxGap}     min={5}  max={80} step={5}  onChange={v=>setCvParams(p=>({...p,maxGap:v}))} />
        </Section>
      )}

      {/* Canvas */}
      <div style={{position:'relative',width:'100%',maxWidth:720,aspectRatio:'4/3',
                   background:C.surface,borderRadius:12,border:`1px solid ${C.border}`,
                   overflow:'hidden',touchAction:'none',
                   display:'flex',alignItems:'center',justifyContent:'center'}}
           onWheel={onWheel}>
        {!imageData && (
          <div style={{color:C.muted,textAlign:'center',pointerEvents:'none'}}>
            ยังไม่มีภาพ<br/>กดถ่ายหรืออัปโหลด
          </div>
        )}
        <div style={{
          width:'100%', height:'100%',
          display:'flex', alignItems:'center', justifyContent:'center',
          transformOrigin:'center', willChange:'transform',
          transform: zoom===1 ? '' : `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
        }}>
          <canvas ref={canvasRef}
            style={{display:imageData?'block':'none',maxWidth:'100%',maxHeight:'100%',
                    objectFit:'contain',
                    cursor:roiMode?'crosshair':manualMode?'cell':zoom>1?'grab':'default'}}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onContextMenu={onContextMenu}
          />
        </div>

        {/* Floating toolbar */}
        {imageData && (
          <div style={{position:'absolute',bottom:10,left:'50%',transform:'translateX(-50%)',
                       display:'flex',alignItems:'center',gap:5,padding:'6px 10px',
                       background:'rgba(10,14,36,0.85)',borderRadius:32,
                       backdropFilter:'blur(6px)',WebkitBackdropFilter:'blur(6px)',
                       zIndex:20,flexWrap:'wrap',justifyContent:'center',
                       maxWidth:'calc(100% - 16px)'}}>

            <button onClick={()=>setManualMode(v=>!v)} style={{
              padding:'5px 11px',border:`1.5px solid ${manualMode?C.orange:'rgba(255,255,255,0.22)'}`,
              borderRadius:20,background:manualMode?C.orange:'rgba(255,255,255,0.1)',
              color:manualMode?'#fff':'#ddd',fontSize:'0.76rem',fontWeight:600,cursor:'pointer',
            }}>✏️ {manualMode?'หยุด':'นับมือ'}</button>

            <button onClick={()=>setManualDots(d=>{const n=d.slice(0,-1);setResult(autoCount+n.length);return n})}
              disabled={!manualDots.length}
              style={{padding:'5px 11px',border:'1.5px solid rgba(255,255,255,0.22)',
                borderRadius:20,background:'rgba(255,255,255,0.1)',color:'#ddd',
                fontSize:'0.76rem',fontWeight:600,cursor:'pointer',
                opacity:manualDots.length?1:0.3}}>↩</button>

            <button onClick={()=>{setManualDots([]);setResult(autoCount)}}
              style={{padding:'5px 10px',border:'1.5px solid rgba(255,255,255,0.22)',
                borderRadius:20,background:'rgba(255,255,255,0.1)',color:'#ddd',
                fontSize:'0.76rem',cursor:'pointer'}}>🗑</button>

            <div style={{width:1,height:22,background:'rgba(255,255,255,0.18)'}}/>
            <button onClick={()=>{setRoiMode(v=>!v)}} style={{
              padding:'5px 11px',
              border:`1.5px solid ${roiMode?C.teal:(roi?'#22d3ee':'rgba(255,255,255,0.22)')}`,
              borderRadius:20,
              background:roiMode?C.teal:roi?'rgba(34,211,238,0.15)':'rgba(255,255,255,0.1)',
              color:roiMode?'#fff':roi?'#22d3ee':'#ddd',
              fontSize:'0.76rem',fontWeight:600,cursor:'pointer',
            }}>{roiMode ? '✕ วาดโซน' : roi ? '📐 โซน✓' : '📐 โซน'}</button>
            {roi && (
              <button onClick={()=>{setRoi(null);setClusters([]);setAutoCount(0);setResult(null);setProfileData([])}} style={{
                padding:'5px 9px',border:'1.5px solid rgba(255,255,255,0.22)',
                borderRadius:20,background:'rgba(255,255,255,0.1)',color:'#ddd',
                fontSize:'0.76rem',cursor:'pointer',
              }}>ล้างโซน</button>
            )}

            {(mode==='cv'||mode==='yprofile') && (<>
              <div style={{width:1,height:22,background:'rgba(255,255,255,0.18)'}}/>
              <button onClick={()=>setShowLines(v=>!v)} style={{
                padding:'5px 11px',border:`1.5px solid ${showLines?C.teal:'rgba(255,255,255,0.22)'}`,
                borderRadius:20,background:showLines?C.teal:'rgba(255,255,255,0.1)',
                color:showLines?'#fff':'#ddd',fontSize:'0.76rem',fontWeight:600,cursor:'pointer',
              }}>เส้น</button>
            </>)}

            <button onClick={()=>setFalseColor(v=>!v)} style={{
              padding:'5px 11px',border:`1.5px solid ${falseColor?'#7c3aed':'rgba(255,255,255,0.22)'}`,
              borderRadius:20,background:falseColor?'#7c3aed':'rgba(255,255,255,0.1)',
              color:falseColor?'#fff':'#ddd',fontSize:'0.76rem',fontWeight:600,cursor:'pointer',
            }}>ย้อมสี</button>

            <div style={{width:1,height:22,background:'rgba(255,255,255,0.18)'}}/>
            <div style={{display:'flex',alignItems:'center',gap:4}}>
              <span style={{fontSize:'0.62rem',color:'rgba(255,255,255,0.5)'}}>AUTO</span>
              <input type="range" min="0.5" max="3" step="0.1" value={badgeSize}
                onChange={e=>setBadgeSize(parseFloat(e.target.value))}
                style={{width:55,accentColor:C.orange}}/>
              <span style={{fontSize:'0.62rem',color:'rgba(255,255,255,0.5)'}}>มือ</span>
              <input type="range" min="0.4" max="3" step="0.1" value={dotSize}
                onChange={e=>setDotSize(parseFloat(e.target.value))}
                style={{width:55,accentColor:C.orange}}/>
            </div>
          </div>
        )}
      </div>

      {/* Status */}
      <div style={{width:'100%',maxWidth:720,padding:'9px 14px',
                   background:C.surface,borderRadius:8,fontSize:'0.85rem',color:C.muted,
                   borderLeft:`4px solid ${status.type==='ok'?C.green:status.type==='error'?C.red:C.accent}`}}>
        {status.msg}
        {mode==='yprofile' && profileData.length===0 && imageData && (
          <span style={{color:C.accent}}> — กด "คำนวณ Y-Profile" เพื่อเริ่ม</span>
        )}
      </div>

      {/* Result */}
      {result !== null && (
        <div style={{width:'100%',maxWidth:720,padding:'16px 20px',textAlign:'center',
                     background:C.surface,borderRadius:10,border:`1px solid ${C.border}`}}>
          <div style={{fontSize:'0.82rem',color:C.muted,marginBottom:4}}>จำนวนแผ่นเหล็กที่ตรวจพบ</div>
          <div style={{fontSize:'3rem',fontWeight:800,color:C.accent,lineHeight:1.1}}>{total}</div>
          {manualDots.length > 0 && (
            <div style={{fontSize:'0.8rem',color:C.muted,marginTop:6}}>
              AUTO <strong style={{color:C.accent}}>{autoCount}</strong>
              {' '}+ มือ <strong style={{color:C.orange}}>{manualDots.length}</strong>
              {' '}= รวม <strong style={{color:C.green}}>{total}</strong> แผ่น
            </div>
          )}
        </div>
      )}

      {/* Image adjustments */}
      {imageData && (
        <div style={{width:'100%',maxWidth:720,padding:'14px 16px',background:C.surface,
                     borderRadius:10,border:`1px solid ${C.border}`,
                     display:'flex',gap:16,flexWrap:'wrap',alignItems:'flex-end'}}>
          <div style={{flex:1,minWidth:130}}>
            <Slider label="ความสว่าง" value={brightness} min={-100} max={100} step={5} onChange={setBrightness} />
          </div>
          <div style={{flex:1,minWidth:130}}>
            <Slider label="ความคมชัด" value={contrast} min={-50} max={100} step={5} onChange={setContrast} />
          </div>
          <div style={{flex:1,minWidth:130}}>
            <Slider label={`หมุนภาพ ${rotation}°`} value={rotation} min={-45} max={45} step={0.5} onChange={setRotation} />
          </div>
          <button onClick={()=>{setBrightness(0);setContrast(0);setRotation(0)}}
            style={{padding:'6px 12px',border:`1.5px solid ${C.border}`,borderRadius:6,
                    background:'transparent',color:C.muted,fontSize:'0.78rem',cursor:'pointer'}}>
            รีเซ็ต
          </button>
        </div>
      )}

      {zoom > 1 && (
        <Btn onClick={()=>{setZoom(1);setPan({x:0,y:0})}}>1:1 รีเซ็ตซูม</Btn>
      )}

    </div>
  )
}
