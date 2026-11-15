#!/usr/bin/env bash

BASE=http://localhost:4317
TOKEN='82f7de5b7ded04bd22de25dbbfb6f605f892ffbec9e176b0c014ad1e97211dfc'
SID='3abc2a99-a8f0-457b-838a-f172d8ec34c2'

# Roll the session over (201 returns the new session)
curl -s -X POST "$BASE/api/sessions/$SID/rollover" \
  -H "Authorization: Bearer $TOKEN" | jq
