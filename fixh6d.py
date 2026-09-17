# -*- coding: utf-8 -*-
import base64
BL = chr(123)
BR = chr(125)
DQ = chr(34)
BN = chr(92)
DL = chr(36)  # dollar sign
SQ = chr(39)  # single quote

def make_chunk6():
    parts = []
    parts.append('')
    parts.append('async fn browse_folder(')
    parts.append('    State(_state): State<Arc<ServerState>>,')
    parts.append(') -> impl IntoResponse ' + BL)
    parts.append('    ' + chr(35) + chr(91) + 'cfg(target_os = ' + DQ + 'windows' + DQ + ')]')
    parts.append('    ' + BL)
    parts.append('        use std::process::Command;')
    parts.append('        use std::process::Stdio;')
    # Build script line: use escaped DQ for Rust string
    # The script uses single quotes, so only DQ needed at start/end
    script = 'Add-Type -AssemblyName System.Windows.Forms; ' + DL + 'fb = New-Object System.Windows.Forms.FolderBrowserDialog; ' + DL + 'fb.Description = ' + SQ + 'Select a folder' + SQ + '; if (' + DL + 'fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ' + DL + 'fb.SelectedPath } else { ' + SQ + SQ + ' }'
    # Escape DQ inside script to \DQ for Rust
    rust_script = script.replace(DQ, BN + DQ)
    parts.append('        let script = ' + DQ + rust_script + DQ + ';')
    parts.append('        let output = Command::new(' + DQ + 'powershell' + DQ + ')')
    parts.append('            .arg(' + DQ + '-NoProfile' + DQ + ')')
    parts.append('            .arg(' + DQ + '-Command' + DQ + ')')
    parts.append('            .arg(script)')
    parts.append('            .creation_flags(0x08000000)')
    parts.append('            .stdout(Stdio::piped())')
    parts.append('            .stderr(Stdio::piped())')
    parts.append('            .output();')
    parts.append('        match output ' + BL)
    parts.append('            Ok(out) => ' + BL)
    parts.append('                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();')
    parts.append('                if stdout.is_empty() ' + BL)
    parts.append('                    raw_json(serde_json::json!(' + BL + DQ + 'ok' + DQ + ': false, ' + DQ + 'path' + DQ + ': ' + DQ + DQ + BR + '))')
    parts.append('                ' + BR + ' else ' + BL)
    parts.append('                    raw_json(serde_json::json!(' + BL + DQ + 'ok' + DQ + ': true, ' + DQ + 'path' + DQ + ': stdout' + BR + '))')
    parts.append('                ' + BR)
    parts.append('            ' + BR)
    parts.append('            Err(_) => json_err(StatusCode::INTERNAL_SERVER_ERROR, ' + DQ + 'Failed to run dialog' + DQ + '),')
    parts.append('        ' + BR)
    parts.append('    ' + BR)
    parts.append('    ' + chr(35) + chr(91) + 'cfg(not(target_os = ' + DQ + 'windows' + DQ + ')]')
    parts.append('    ' + BL)
    parts.append('        json_err(StatusCode::NOT_IMPLEMENTED, ' + DQ + 'browse-folder not supported' + DQ + ')')
    parts.append('    ' + BR)
    parts.append(BR)
    return chr(10).join(parts) + chr(10)

text = make_chunk6()
for line in text.split(chr(10)):
    if 'script = ' in line:
        print('Script line:', repr(line))

encoded = base64.b64encode(text.encode('utf-8')).decode('ascii')
with open('d:/game/mytemple/h_chunk6.b64', 'w') as f:
    f.write(encoded)
print('Wrote h_chunk6:', len(text), 'chars')
