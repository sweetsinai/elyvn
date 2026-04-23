import sys
import re

def find_unclosed(filepath):
    with open(filepath, 'r') as f:
        content = f.read()
    
    # Remove comments
    content = re.sub(r'/\*.*?\*/', '', content, flags=re.DOTALL)
    content = re.sub(r'//.*', '', content)
    
    # Find tags manually
    stack = []
    i = 0
    while i < len(content):
        if content[i:i+4] == '<div':
            # Found a start
            # Find the end of this tag
            tag_end = content.find('>', i)
            tag_content = content[i:tag_end+1]
            if tag_content.strip().endswith('/>'):
                # Self-closing
                pass
            else:
                line_num = content[:i].count('\n') + 1
                stack.append((line_num, i))
            i = tag_end + 1
        elif content[i:i+6] == '</div>':
            if stack:
                stack.pop()
            else:
                line_num = content[:i].count('\n') + 1
                print(f"Extra closing div at line {line_num}")
            i += 6
        else:
            i += 1
            
    for line_num, pos in stack:
        print(f"Unclosed div starting at line {line_num}")

if __name__ == "__main__":
    find_unclosed(sys.argv[1])
