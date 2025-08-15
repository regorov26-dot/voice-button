(function(){
  // DOM
  const mainBtn = document.getElementById('mainBtn');
  const resetBtn = document.getElementById('resetBtn');
  const statusEl = document.getElementById('status');
  const recIndicator = document.getElementById('recIndicator');

  const confirmOverlay = document.getElementById('confirmOverlay');
  const confirmOk = document.getElementById('confirmOk');
  const confirmCancel = document.getElementById('confirmCancel');

  // Состояния
  let state = 'idle', hasRecorded = false;

  // Запись
  let mediaRecorder = null, chunks = [], currentStream = null;
  const MAX_SECONDS = 5;
  let secLeft = MAX_SECONDS, timerId = null;

  // Аудио
  let audioEl = null, audioURL = null;

  // Сброс/обработка
  let isResetting = false, processing = false, abortProcessing = false;

  // Мягкий трим (RMS + преролл)
  const SILENCE_RMS_THRESHOLD = 0.015;
  const RMS_WINDOW_MS = 60;
  const PRE_ROLL_MS = 120;
  const MAX_TRIM_MS = 1500;
  const MIX_TO_MONO = true;

  // Авто‑закрытие микрофона
  const MIC_IDLE_TIMEOUT_MS = 30000; // 30 сек
  let micIdleTimer = null;

  // Формат записи (AAC предпочтителен для iOS Safari)
  function pickBestMime(){
    const a=document.createElement('audio');
    const list=['audio/mp4;codecs=mp4a.40.2','audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'];
    for(const t of list){ if(typeof MediaRecorder!=='undefined' && MediaRecorder.isTypeSupported?.(t) && a.canPlayType?.(t.replace(/;.*$/,''))!==''){ return t; } }
    return '';
  }
  const SELECTED_MIME = pickBestMime();

  // UI helpers
  const fmt=(s)=>`00:0${s}`.slice(-5);
  const setStatus = (html)=>{ statusEl.innerHTML = html; };
  function setButtonToRecord(){ mainBtn.textContent='Запись'; mainBtn.setAttribute('aria-label','Начать запись'); }
  function setButtonToPlay(){ mainBtn.textContent='Пуск'; mainBtn.setAttribute('aria-label','Проиграть запись с начала'); }
  function renderRecordingLabel(){ mainBtn.textContent=`Стоп ${fmt(secLeft)}`; mainBtn.setAttribute('aria-label','Остановить запись'); }
  function showIndicator(on){ recIndicator.classList.toggle('show', !!on); }
  function startCountdown(){
    secLeft=MAX_SECONDS; renderRecordingLabel(); showIndicator(true);
    timerId=setInterval(()=>{ secLeft--; renderRecordingLabel(); if(secLeft<=0) stopRecording(); },1000);
  }
  function clearCountdown(){ clearInterval(timerId); timerId=null; showIndicator(false); }

  // Автозакрытие микрофона
  function scheduleMicAutoClose(){ cancelMicAutoClose(); if(currentStream){ micIdleTimer=setTimeout(()=> micAutoClose(), MIC_IDLE_TIMEOUT_MS); } }
  function cancelMicAutoClose(){ if(micIdleTimer){ clearTimeout(micIdleTimer); micIdleTimer=null; } }
  function micAutoClose(){ stopTracks(); mediaRecorder=null; setStatus('Микрофон автоматически закрыт из‑за бездействия. Нажми «Запись», чтобы открыть заново.'); }

  // Низкоуровневые утилиты
  function stopTracks(){
    if(currentStream){
      currentStream.getTracks?.().forEach(tr=>{ try{ tr.stop(); }catch{} });
      currentStream = null;
    }
  }
  function cleanupRecorder(){
    if(mediaRecorder){
      mediaRecorder.ondataavailable = null;
      mediaRecorder.onstop = null;
      mediaRecorder.onerror = null;
    }
    mediaRecorder = null;
    stopTracks();
  }
  function revokeAudio(){
    if(audioEl){ try{ audioEl.pause(); }catch{} }
    if(audioURL){ URL.revokeObjectURL(audioURL); audioURL = null; }
    if(audioEl){ audioEl.src=''; audioEl.removeAttribute('src'); audioEl.load?.(); audioEl = null; }
  }
  function uiToIdle(){
    setButtonToRecord();
    mainBtn.disabled = false;
    resetBtn.disabled = true;
    setStatus('Готово к новой записи. Нажми «Запись».');
    showIndicator(false);
  }

  // WAV экспорт (16‑bit PCM моно)
  function pcm16WavFromFloat32(float32Data, sampleRate){
    const numChannels=1, bytesPerSample=2, blockAlign=numChannels*bytesPerSample, byteRate=sampleRate*blockAlign;
    const dataLength=float32Data.length*bytesPerSample;
    const buffer=new ArrayBuffer(44+dataLength), view=new DataView(buffer);
    function wr(off,s){ for(let i=0;i<s.length;i++) view.setUint8(off+i,s.charCodeAt(i)); }
    wr(0,'RIFF'); view.setUint32(4,36+dataLength,true); wr(8,'WAVE'); wr(12,'fmt '); view.setUint32(16,16,true);
    view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,sampleRate,true); view.setUint32(28,byteRate,true);
    view.setUint16(32,blockAlign,true); view.setUint16(34,16,true); wr(36,'data'); view.setUint32(40,dataLength,true);
    let off=44; for(let i=0;i<float32Data.length;i++){ let s=Math.max(-1,Math.min(1,float32Data[i])); view.setInt16(off, s<0?s*0x8000:s*0x7FFF, true); off+=2; }
    return new Blob([view],{type:'audio/wav'});
  }
  function rmsWindowed(data,start,len){ let sum=0; const end=Math.min(start+len,data.length);
    for(let i=start;i<end;i++){ const v=data[i]; sum+=v*v; } return Math.sqrt(sum/Math.max(1,end-start)); }
  async function trimLeadingSilenceSoft(inputBlob){
    const ac=new (window.AudioContext||window.webkitAudioContext)();
    const ab=await inputBlob.arrayBuffer();
    const audioBuffer=await ac.decodeAudioData(ab);
    const sr=audioBuffer.sampleRate, ch=audioBuffer.numberOfChannels, total=audioBuffer.length;

    let mono=new Float32Array(total);
    if(MIX_TO_MONO && ch>1){
      for(let c=0;c<ch;c++){
        const d=audioBuffer.getChannelData(c);
        for(let i=0;i<total;i++) mono[i]+=d[i]/ch;
      }
    } else {
      mono = audioBuffer.getChannelData(0).slice(0);
    }

    const win=Math.max(1,Math.round(sr*(RMS_WINDOW_MS/1000)));
    const maxTrimSamples=Math.round(sr*(MAX_TRIM_MS/1000));
    const preRoll=Math.round(sr*(PRE_ROLL_MS/1000));

    let idx=0, found=-1;
    while(idx<Math.min(maxTrimSamples, mono.length-win)){
      const r=rmsWindowed(mono,idx,win);
      if(r>=SILENCE_RMS_THRESHOLD){ found=idx; break; }
      idx += Math.floor(win/2);
    }
    let startIndex=0;
    if(found>=0){ startIndex=Math.max(0, found - preRoll); }
    const trimmed=(startIndex>0 && startIndex<mono.length)? mono.subarray(startIndex) : mono;

    const wavBlob=pcm16WavFromFloat32(trimmed,sr);
    ac.close?.();
    return wavBlob;
  }

  // Инициализация рекордера
  async function initRecorder(){
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('Браузер не поддерживает запись аудио.');
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    currentStream = stream;
    cancelMicAutoClose();
    const opts=SELECTED_MIME?{mimeType:SELECTED_MIME}:undefined;
    const mr=new MediaRecorder(stream,opts);

    mr.ondataavailable=(e)=>{ if(e.data && e.data.size) chunks.push(e.data); };
    mr.onerror=(e)=>{ if(!isResetting) setStatus('Ошибка записи: '+(e.error?.message||e.message||e)); };

    mr.onstop=async()=>{
      showIndicator(false);
      if(isResetting){
        chunks=[]; processing=false; abortProcessing=false;
        isResetting=false;
        cleanupRecorder(); revokeAudio(); hasRecorded=false; state='idle'; uiToIdle();
        return;
      }

      processing=true;
      try{
        const type=mr.mimeType || SELECTED_MIME || 'audio/mp4';
        const rawBlob=new Blob(chunks,{type}); chunks=[];
        setStatus('Обработка… аккуратно обрезаю тишину в начале…');
        const wavBlob=await trimLeadingSilenceSoft(rawBlob);

        if(abortProcessing){
          abortProcessing=false; processing=false; cleanupRecorder();
          return;
        }

        revokeAudio();
        audioURL=URL.createObjectURL(wavBlob);
        audioEl=new Audio(); audioEl.preload='auto'; audioEl.src=audioURL;

        hasRecorded=true; state='ready';
        setButtonToPlay(); mainBtn.disabled=false; resetBtn.disabled=false;
        setStatus('Готово. «Пуск» — воспроизведение с начала (вибрация при старте). «Сбросить» — записать заново.');

        // микрофон больше не нужен — включим авто‑закрытие
        scheduleMicAutoClose();
      }catch(err){
        if(isResetting || abortProcessing){
          abortProcessing=false; isResetting=false; processing=false;
          cleanupRecorder(); revokeAudio(); hasRecorded=false; state='idle'; uiToIdle();
        }else{
          setStatus('Не удалось обработать клип: '+(err?.message||err));
        }
      }finally{
        processing=false;
        cleanupRecorder();
      }
    };

    return mr;
  }

  // Запись
  async function startRecording(){
    if(hasRecorded) return;
    if(!mediaRecorder) mediaRecorder = await initRecorder();
    cancelMicAutoClose();
    chunks=[]; state='recording';
    startCountdown();
    setStatus('Идёт запись (до 5 сек). Нажми «Стоп» (повторно по кнопке), чтобы сохранить раньше.');
    try{
      mediaRecorder.start();
      resetBtn.disabled=false; // разрешим сбрасывать даже во время записи
    }catch(err){
      state='idle'; showIndicator(false); setButtonToRecord();
      setStatus('Не удалось начать запись: '+(err.message||err));
    }
  }
  function stopRecording(){
    if(state!=='recording') return;
    clearCountdown(); state='idle';
    try{ mediaRecorder.stop(); }catch{}
  }

  // Проигрывание: каждый клик — с начала; вибрация при старте
  async function playFromStart(){
    if(!audioEl || !audioURL) return;
    try{
      audioEl.pause(); audioEl.currentTime=0;
      try{ navigator.vibrate?.(30); }catch{}
      await audioEl.play();
      setStatus('Воспроизведение…');
    }catch(e){
      try{ audioEl.load(); }catch{}
      await new Promise(r=>setTimeout(r,120));
      try{
        audioEl.currentTime=0; navigator.vibrate?.(30); await audioEl.play();
        setStatus('Воспроизведение…');
      }catch(e2){
        setStatus('Не удаётся проиграть клип. Нажми «Пуск» ещё раз.');
      }
    }
  }

  // Кнопка
  async function onMainButtonClick(){
    if(state==='idle' && !hasRecorded){ await startRecording(); }
    else if(state==='recording'){ stopRecording(); }
    else if(state==='ready'){ setButtonToPlay(); playFromStart(); }
  }

  // Модальное подтверждение
  function showConfirm(){
    confirmOverlay.classList.add('show');
    confirmOverlay.setAttribute('aria-hidden','false');
    return new Promise((resolve)=>{
      function cleanup(){
        confirmOverlay.classList.remove('show');
        confirmOverlay.setAttribute('aria-hidden','true');
        confirmOk.removeEventListener('click', onOk);
        confirmCancel.removeEventListener('click', onCancel);
        confirmOverlay.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
      }
      function onOk(){ cleanup(); resolve(true); }
      function onCancel(){ cleanup(); resolve(false); }
      function onBackdrop(e){ if(e.target===confirmOverlay){ cleanup(); resolve(false); } }
      function onKey(e){ if(e.key==='Escape'){ cleanup(); resolve(false); } }
      confirmOk.addEventListener('click', onOk);
      confirmCancel.addEventListener('click', onCancel);
      confirmOverlay.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
  }

  // Жёсткий сброс
  function hardReset(){
    isResetting = true; abortProcessing = true;
    clearCountdown();
    if(state==='recording' && mediaRecorder){
      try{ mediaRecorder.stop(); }catch{}
      return; // остальное сделает onstop
    }
    revokeAudio(); chunks=[]; cleanupRecorder();
    hasRecorded=false; state='idle'; uiToIdle();
    isResetting=false; abortProcessing=false;
  }

  // Навешиваем обработчики
  mainBtn.addEventListener('click', onMainButtonClick);
  resetBtn.addEventListener('click', async ()=>{
    const ok = await showConfirm();
    if(!ok) return;
    hardReset();
  });
  setButtonToRecord();

  // HTTPS подсказка
  if(location.protocol!=='https:' && location.hostname!=='localhost' && location.hostname!=='127.0.0.1'){
    setStatus('Запись микрофона работает только на HTTPS или localhost. Открой через HTTPS.');
  }
})();
