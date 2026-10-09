"""Generate bcrypt password hash for admin user.

Usage:
    python -m mss_ai_ppt_sample_assets.backend.scripts.generate_admin_password

This script will prompt for a password and generate a bcrypt hash
that can be added to the .env file as ADMIN_PASSWORD_HASH.
"""

import sys
import getpass
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from mss_ai_ppt_sample_assets.backend.modules.admin_auth import get_password_hash


def main():
    """Main function to generate password hash."""
    print("=" * 60)
    print("Admin Password Hash Generator")
    print("=" * 60)
    print()

    # Get password from user
    while True:
        password = getpass.getpass("Enter admin password: ")
        if len(password) < 8:
            print("❌ Password must be at least 8 characters long.")
            continue

        confirm = getpass.getpass("Confirm password: ")
        if password != confirm:
            print("❌ Passwords do not match. Please try again.")
            continue

        break

    print()
    print("Generating bcrypt hash...")

    # Generate hash
    password_hash = get_password_hash(password)

    print()
    print("=" * 60)
    print("✓ Password hash generated successfully!")
    print("=" * 60)
    print()
    print("Add this to your .env file:")
    print()
    print(f"ADMIN_PASSWORD_HASH={password_hash}")
    print()
    print("=" * 60)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nOperation cancelled by user.")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)
