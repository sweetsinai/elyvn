import sys

def count_divs(filepath):
    with open(filepath, 'r') as f:
        content = f.read()
    
    opens = content.count('<div')
    closes = content.count('</div>')
    print(f"Opens: {opens}, Closes: {closes}")

if __name__ == "__main__":
    count_divs(sys.argv[1])
