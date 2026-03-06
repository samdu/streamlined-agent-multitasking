#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Parses codeserver:// URLs and delegates to cs-spawn
# Formats:
#   codeserver://open?repo=github/data-dbt
#   codeserver://open?repo=github/data-dbt&newtree
#   codeserver://open?repo=github/data-dbt&newtree=my-feature

URL="$1"
[ -z "$URL" ] && exit 1

# Parse query string with python for reliability
eval "$(python3 -c "
import sys, urllib.parse
url = sys.argv[1]
parsed = urllib.parse.urlparse(url)
params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)

repo = params.get('repo', [''])[0]
print(f'REPO={urllib.parse.quote(repo, safe=\"/._-\")!r}')

if 'newtree' in params:
    val = params['newtree'][0]
    if val:
        print(f'NEWTREE={val!r}')
    else:
        print('NEWTREE=__auto__')
else:
    print('NEWTREE=\"\"')
" "$URL")"

if [ -z "$REPO" ]; then
  osascript -e "display alert \"cs-spawn\" message \"No repo in URL: $URL\""
  exit 1
fi

# Build args
ARGS=("$REPO")
if [ -n "$NEWTREE" ]; then
  if [ "$NEWTREE" = "__auto__" ]; then
    ARGS+=("--newtree")
  else
    ARGS+=("--newtree=$NEWTREE")
  fi
fi

"${HOME}/.local/bin/cs-spawn" "${ARGS[@]}"
