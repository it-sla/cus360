import json
import re

content = open(r'C:\Users\ssrs\.gemini\antigravity\brain\1707f21c-cab8-4535-ba4b-63b53a3fa6ca\.system_generated\steps\4673\content.md', 'r', encoding='utf-8').read()

blocks = re.split(r'\"|\$', content)
for block in blocks:
    if 'import ' in block and 'PieChart' in block and len(block) > 100:
        print("MATCH: ", block[:500].replace('\\n', '\n'))
        print('---')
