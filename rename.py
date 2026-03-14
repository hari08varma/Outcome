import os

repo_root = r"c:\Users\prana\Downloads\Outcome\layer5"
extensions = ('.ts', '.md', '.json', '.toml', '.sql', '.example', '.yaml', '.yml', '.env.example', '.py')

for root, dirs, files in os.walk(repo_root):
    if any(ignore in root for ignore in ['.git', 'node_modules', 'dist', 'venv']):
        continue
    for file in files:
        if not file.endswith(extensions):
            continue
        filepath = os.path.join(root, file)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
            
            orig = content
            
            # Protect folder paths that exist and shouldn't be renamed
            content = content.replace('working-directory: layer5/', '%%WORKING_DIR%%')
            content = content.replace('layer5/api', '%%L5_API%%')
            content = content.replace('layer5/dashboard', '%%L5_DASH%%')
            content = content.replace('/layer5/api', '%%L5_SLASH_API%%')
            content = content.replace('/layer5/dashboard', '%%L5_SLASH_DASH%%')
            content = content.replace('layer5/sdks', '%%L5_SDKS%%')
            content = content.replace('/layer5/sdks', '%%L5_SLASH_SDKS%%')

            # The main replacements
            content = content.replace('LAYER5', 'LAYERINFINITE')
            content = content.replace('Layer5', 'Layerinfinite')
            content = content.replace('layer5', 'layerinfinite')

            # Restore the protected folder paths
            content = content.replace('%%WORKING_DIR%%', 'working-directory: layer5/')
            content = content.replace('%%L5_API%%', 'layer5/api')
            content = content.replace('%%L5_DASH%%', 'layer5/dashboard')
            content = content.replace('%%L5_SLASH_API%%', '/layer5/api')
            content = content.replace('%%L5_SLASH_DASH%%', '/layer5/dashboard')
            content = content.replace('%%L5_SDKS%%', 'layer5/sdks')
            content = content.replace('%%L5_SLASH_SDKS%%', '/layer5/sdks')
            
            if content != orig:
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f"Updated {filepath}")
        except Exception as e:
            print(f"Failed on {filepath}: {e}")
