; OpenAULA installer (Inno Setup 6)
;
; Tauri's own bundlers (NSIS / WiX) both want to download their toolchain on
; first use, which fails on a machine without access to GitHub. Inno Setup is
; installed locally, so this script wraps the already-built release binary
; instead - no network needed.
;
; Build:
;   1. npm run tauri build            (produces src-tauri\target\release\openaula.exe)
;   2. "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\openaula.iss
;
; The Tauri app is a single self-contained exe (frontend assets are embedded),
; so there is nothing else to ship. WebView2 is required at runtime; Windows 10
; 1803+ and Windows 11 ship it, so it is not bundled here.

#define AppName "OpenAULA"
#define AppVersion "1.0.0"
#define AppExe "openaula.exe"
#define SourceExe "..\src-tauri\target\release\openaula.exe"

[Setup]
AppId={{7E2C4B1A-9D3F-4A6E-8B51-2F0C7A4E1D93}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
VersionInfoVersion={#AppVersion}
AppPublisher={#AppName}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
OutputDir=..\installer-out
OutputBaseFilename={#AppName}-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#AppExe}
; The driver talks to the keyboard over HID at user level, so installing it
; needs no elevation either. With "lowest", {autopf} resolves to the per-user
; Programs folder (%LOCALAPPDATA%\Programs) and Windows shows no UAC prompt.
PrivilegesRequired=lowest

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
