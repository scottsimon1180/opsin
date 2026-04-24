import os
import shutil
import re
from datetime import datetime

# Configuration
SOURCE_DIR = r"C:\Custom Scripts\HTML\7 Opsin - Image Editor"
DEST_DIR = r"C:\Custom Scripts\HTML\7 Opsin - ASSETS\_BACKUPS"

def get_next_backup_number(dest_path):
    """Scans the destination directory and calculates the next logical backup integer."""
    max_num = 0
    if os.path.exists(dest_path):
        for item in os.listdir(dest_path):
            # Evaluate directories only
            if os.path.isdir(os.path.join(dest_path, item)):
                # Isolate leading integers via regex
                match = re.match(r'^(\d+)', item)
                if match:
                    num = int(match.group(1))
                    if num > max_num:
                        max_num = num
    return max_num + 1

def format_timestamp():
    """Generates a Windows-safe timestamp mirroring the requested format."""
    now = datetime.now()
    
    # date format: M-D-YY
    date_str = f"{now.month}-{now.day}-{now.strftime('%y')}"
    
    # time format: I.MMp (stripping leading zero from hour, lowering am/pm)
    hour = int(now.strftime('%I'))
    minute = now.strftime('%M')
    meridian = now.strftime('%p').lower()
    time_str = f"{hour}.{minute}{meridian}"
    
    return f"{date_str} - {time_str}"

def execute_backup():
    print(f"Source Directory: {SOURCE_DIR}")
    print(f"Destination Base: {DEST_DIR}")
    print("-" * 50)

    # Validate source directory existence
    if not os.path.exists(SOURCE_DIR):
        print(f"CRITICAL ERROR: Source directory not found at: {SOURCE_DIR}")
        input("\nPress Enter to exit...")
        return

    # Ensure the base destination directory exists prior to scanning
    os.makedirs(DEST_DIR, exist_ok=True)

    # Determine dynamic naming variables
    next_num = get_next_backup_number(DEST_DIR)
    timestamp = format_timestamp()

    # Construct the final target path
    new_folder_name = f"{next_num} BACKUP [{timestamp}]"
    target_path = os.path.join(DEST_DIR, new_folder_name)

    print(f"Targeting new archive: {new_folder_name}")
    print("Initiating file transfer...")

    try:
        # copytree guarantees it will only CREATE a directory.
        # ignore_patterns securely excludes the specific script from the pool.
        shutil.copytree(
            SOURCE_DIR, 
            target_path,
            ignore=shutil.ignore_patterns("z__OPSIN BACKUP.py")
        )
        
        # Accurately audit the destination to get the exact file count written
        file_count = sum(len(files) for _, _, files in os.walk(target_path))
        print(f"\nSUCCESS: {file_count} files backed up successfully!")

    except shutil.Error as e:
        # shutil.Error catches partial failures (e.g., locked files)
        # while still allowing the rest of the directory to copy safely.
        file_count = sum(len(files) for _, _, files in os.walk(target_path)) if os.path.exists(target_path) else 0
        print(f"\nSUCCESS: {file_count} files backed up!")
        print("\nWARNING: The following files encountered errors and were NOT backed up:")
        for src, dest, error_msg in e.args[0]:
            # Extract just the filename for cleaner CLI UX
            filename = os.path.basename(src)
            print(f" - File: {filename}\n   Reason: {error_msg}")

    except Exception as e:
        print(f"\nFATAL FAILURE: A critical error interrupted the operation: {e}")

    print("-" * 50)
    # Pause execution to allow review of console output
    input("Press Enter to close this window...")

if __name__ == "__main__":
    execute_backup()