const RUN5K_URL = 'https://run5k.run/api/users/403/profile/dashboard';
const CACHE_KEY = 'ivanov-profile-dashboard';

function corsHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Content-Type': contentType
  };
}

function jsonError(status, error, message) {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: corsHeaders()
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders('text/plain; charset=utf-8')
      });
    }

    if (request.method !== 'GET') {
      return jsonError(405, 'Method not allowed', 'Use GET');
    }

    const profile = new URL(request.url).searchParams.get('profile');
    if (profile === 'yulya') return refreshYulya(request, env);
    if (profile === 'cherdakov') return refreshCherdakov(request, env);
    if (profile && profile !== 'ivanov') return jsonError(400, 'Unknown profile', 'Unknown profile');

    if (!env.RUN5K_CACHE) {
      return jsonError(
        503,
        'KV binding missing',
        'Create a Workers KV namespace and bind it to this Worker as RUN5K_CACHE.'
      );
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'refresh';

    if (action === 'saved') {
      try {
        const saved = await env.RUN5K_CACHE.getWithMetadata(CACHE_KEY, 'text');
        if (!saved || !saved.value) {
          return jsonError(404, 'No saved snapshot', 'Press «Обновить результаты» once to create it.');
        }
        const headers = corsHeaders('application/json; charset=utf-8');
        if (saved.metadata && saved.metadata.updatedAt) {
          headers['X-Run5k-Saved-At'] = saved.metadata.updatedAt;
        }
        return new Response(saved.value, { status: 200, headers });
      } catch (error) {
        return jsonError(500, 'KV read failed', error instanceof Error ? error.message : String(error));
      }
    }

    if (action !== 'refresh') {
      return jsonError(400, 'Unknown action', 'Use action=saved or action=refresh');
    }

    try {
      const upstreamUrl = new URL(RUN5K_URL);
      upstreamUrl.searchParams.set('_cb', Date.now().toString());

      const upstream = await fetch(upstreamUrl.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://run5k.run/users/ivanov'
        },
        redirect: 'follow',
        cf: {
          cacheEverything: false,
          cacheTtl: 0
        }
      });

      const text = await upstream.text();
      const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

      if (!upstream.ok) {
        const headers = corsHeaders(contentType);
        headers['X-Run5k-Upstream-Status'] = String(upstream.status);
        return new Response(text, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers
        });
      }

      // Do not overwrite a good shared snapshot with a non-JSON/error page.
      JSON.parse(text);

      const updatedAt = new Date().toISOString();
      await env.RUN5K_CACHE.put(CACHE_KEY, text, {
        metadata: { updatedAt }
      });

      const headers = corsHeaders(contentType);
      headers['X-Run5k-Upstream-Status'] = String(upstream.status);
      headers['X-Run5k-Saved-At'] = updatedAt;
      return new Response(text, {
        status: 200,
        headers
      });
    } catch (error) {
      return jsonError(
        502,
        'Worker could not refresh run5k.run',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
};

// The default route above retains the existing Ivanov dashboard contract.
async function refreshCherdakov(request, env) {
  const action = new URL(request.url).searchParams.get('action') || 'refresh';
  const key = 'cherdakov-profile-runs-v1';
  if (action === 'saved') {
    const saved = env.RUN5K_CACHE ? await env.RUN5K_CACHE.get(key) : null;
    return saved ? new Response(saved, {headers: corsHeaders()}) : jsonError(404, 'No snapshot', 'Refresh first');
  }
  if (action !== 'refresh') return jsonError(400, 'Unknown action', 'Use refresh or saved');
  try {
    const runs = [];
    let complete = false;
    for (let offset = 0; offset < 10000; offset += 200) {
      const url = new URL('https://run5k.run/api/users/293/profile/runs');
      url.searchParams.set('limit', '200');
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('_cb', String(Date.now()));
      const response = await fetch(url, {
        headers: {Accept: 'application/json'},
        signal: AbortSignal.timeout(15000),
        cf: {cacheEverything: false, cacheTtl: 0}
      });
      if (!response.ok) throw Error('run5k HTTP ' + response.status);
      const batch = await response.json();
      if (!Array.isArray(batch)) throw Error('Unexpected run5k response');
      for (const r of batch) {
        if (!r || !r.event_date) throw Error('Invalid run5k result');
        if (r.event_date > '2026-09-12' && r.finish_time_display) runs.push(r);
      }
      if (batch.length < 200) { complete = true; break; }
    }
    if (!complete) throw Error('Too many results');
    const payload = JSON.stringify({profile:'cherdakov', updated_at:new Date().toISOString(), runs});
    // A KV failure must not discard a successfully fetched live response.
    if (env.RUN5K_CACHE) { try { await env.RUN5K_CACHE.put(key,payload); } catch(e) { console.error('Snapshot save failed', e); } }
    return new Response(payload, {headers:corsHeaders()});
  } catch(e) { return jsonError(502, 'Refresh failed', e.message); }
}

async function refreshYulya(request,env){
  const action=new URL(request.url).searchParams.get('action')||'refresh';
  const key='yulya-profile-runs-v1';
  try{
    if(!env.RUN5K_CACHE)throw Error('RUN5K_CACHE binding missing');
    if(action==='saved'){
      const saved=await env.RUN5K_CACHE.get(key);
      return saved?new Response(saved,{headers:corsHeaders()}):jsonError(404,'No saved snapshot','Refresh first');
    }
    if(action!=='refresh')return jsonError(400,'Unknown action','Use refresh or saved');
    async function get(path){
      const url=new URL('https://run5k.run/api'+path);url.searchParams.set('_cb',Date.now());
      const response=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000),cf:{cacheEverything:false,cacheTtl:0}});
      if(!response.ok)throw Error('run5k HTTP '+response.status);
      return response.json();
    }
    const user=await get('/users/resolve/yulya');
    if(user.public_slug!=='yulya'||!Number.isInteger(user.serial_id))throw Error('Profile verification failed');
    const prefix='/users/'+user.serial_id+'/profile',runs=[],seen=new Set();let complete=false;
    for(let offset=0;offset<10000;offset+=200){
      const batch=await get(prefix+'/runs?limit=200&offset='+offset);
      if(!Array.isArray(batch))throw Error('Invalid runs response');
      for(const r of batch){
        if(!r||!r.event_date||!r.location_name)throw Error('Invalid result');
        if(r.run_result_id){if(seen.has(r.run_result_id))throw Error('Repeated results page');seen.add(r.run_result_id);}
        runs.push(Object.fromEntries(['event_date','location_name','location_city','location_country','platform_code','finish_time_display','location_slug'].map(k=>[k,r[k]??null])));
      }
      if(batch.length<200){complete=true;break;}
    }
    if(!complete||!runs.length)throw Error('Incomplete or empty results');
    const locations=await get(prefix+'/locations/visited/map');
    if(!Array.isArray(locations.points))throw Error('Invalid location map');
    const points=new Map(locations.points.map(p=>[p.location_slug,p]));
    for(const r of runs){const p=points.get(r.location_slug);if(p&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)){r.latitude=p.latitude;r.longitude=p.longitude;}}
    const updatedAt=new Date().toISOString();
    const payload=JSON.stringify({profile:'yulya',source:'https://run5k.run/users/yulya',updated_at:updatedAt,runs});
    await env.RUN5K_CACHE.put(key,payload,{metadata:{updatedAt}});
    return new Response(payload,{headers:corsHeaders()});
  }catch(error){return jsonError(502,'Refresh failed',error.message);}
}
