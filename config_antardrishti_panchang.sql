-- Staging configuration: give Antardrishti a Jyotisha location so its feeds include the
-- daily Panchangam (calculated by jyotisha-core). Changes only the ws-antardrishti row.
UPDATE workspaces SET feed_profile_json = json_set(COALESCE(feed_profile_json, '{}'),
    '$.jyotisha', json('{"place":"Hyderabad","lat":17.385,"lng":78.4867,"tz":"Asia/Kolkata"}'),
    '$.query', COALESCE(json_extract(feed_profile_json, '$.query'), 'Vedic astrology'))
  WHERE id = 'ws-antardrishti';
