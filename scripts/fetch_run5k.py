#!/usr/bin/env python3
"""Prepare Юлия Лукина public results for the refresh button."""
import json
import math
import os
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PROFILE = 'yulya'
API = 'https://run5k.run/api'

def get(path):
    for attempt in range(3):
        try:
            request = urllib.request.Request(API + path, headers={'User-Agent': 'Mozilla/5.0 (compatible; Run5kResultsUpdater/2.0)', 'Accept': 'application/json'})
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)

def coordinate(value, maximum):
    return isinstance(value, (int, float)) and math.isfinite(value) and abs(value) <= maximum

def refresh():
    user = get('/users/resolve/' + PROFILE)
    if user.get('public_slug') != PROFILE or not isinstance(user.get('serial_id'), int):
        raise ValueError('Не удалось подтвердить профиль yulya')
    prefix = '/users/' + str(user['serial_id']) + '/profile'
    locations = get(prefix + '/locations/visited/map')
    if not isinstance(locations.get('points'), list):
        raise ValueError('Неожиданный формат координат')
    points = {p['location_slug']: p for p in locations['points'] if p.get('location_slug')}
    runs = []
    seen = set()
    offset = 0
    while True:
        batch = get(prefix + '/runs?limit=200&offset=' + str(offset))
        if not isinstance(batch, list):
            raise ValueError('Неожиданный формат результатов')
        for raw in batch:
            if not isinstance(raw, dict) or not raw.get('event_date') or not raw.get('location_name'):
                raise ValueError('Неполная запись результата')
            identity = raw.get('run_result_id')
            if identity and identity in seen:
                raise ValueError('Повтор страницы результатов')
            if identity:
                seen.add(identity)
            record = {k: raw.get(k) for k in ('event_date','location_name','location_city','location_country','platform_code','finish_time_display')}
            point = points.get(raw.get('location_slug'), {})
            lat, lon = point.get('latitude'), point.get('longitude')
            if coordinate(lat, 90) and coordinate(lon, 180):
                record.update(latitude=lat, longitude=lon)
            runs.append(record)
        if len(batch) < 200:
            break
        offset += len(batch)
        if offset > 10000:
            raise ValueError('Превышено число результатов')
    if not runs:
        raise ValueError('Пустой ответ: существующие данные оставлены без изменений')
    data = {'profile': PROFILE, 'source': 'https://run5k.run/users/' + PROFILE, 'runs': runs}
    repository = os.getenv('GITHUB_REPOSITORY')
    if repository:
        data['repository'] = repository
    target = ROOT / 'run5k-results.json'
    content = json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n'
    if target.exists() and target.read_text(encoding='utf-8') == content:
        print('Результаты не изменились')
        return
    temporary = target.with_suffix('.json.tmp')
    temporary.write_text(content, encoding='utf-8')
    temporary.replace(target)
    print('Сохранено результатов:', len(runs))

if __name__ == '__main__':
    refresh()
