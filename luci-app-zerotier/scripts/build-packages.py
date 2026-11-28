#!/usr/bin/env python3
#
# Build OpenWrt packages for luci-app-zerotier.
#
# Produces:
#   dist/luci-app-zerotier_<version>_all.ipk   (opkg / OpenWrt <= 24.10)
#   dist/luci-app-zerotier-<version>.apk       (apk / OpenWrt >= 25.12)
#   dist/luci-app-zerotier.rsa.pub             (key for the signed apk)
#
# The apk is a v2 package (tar.gz sections with .PKGINFO). apk-tools 3.x
# still installs v2 packages, but only if every file carries its checksum
# in a pax header "APK-TOOLS.checksum.SHA1"; without it apk 3 fails with
# "file format is obsolete (e.g. missing embedded checksum)".
#
# Required for signing: pip install cryptography
# Without it, pass --no-sign to build an unsigned apk.

import argparse
import gzip
import hashlib
import io
import os
import sys
import tarfile
import time
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = 'luci-app-zerotier'
TITLE = 'ZeroTier control panel'
URL = 'https://github.com/moseszz007/luci-app-zerotier'
MAINTAINER = 'moseszz007'
LICENSE = 'Apache-2.0'
DESCRIPTION = 'ZeroTier control panel for LuCI'

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    HAVE_CRYPTO = True
except Exception:
    HAVE_CRYPTO = False

POSTINST = b'''#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
default_postinst $0 $@
'''

POSTINST_PKG = b'''[ -n "${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null
	exit 0
}
'''

PRERM = b'''#!/bin/sh
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
default_prerm $0 $@
'''

APK_POSTINST = b'''#!/bin/sh
rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache/
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload
exit 0
'''


def collect_files():
    files = []

    for base, prefix in (('htdocs', 'www'), ('root', '')):
        for path in sorted((ROOT / base).rglob('*')):
            if not path.is_file():
                continue

            rel = path.relative_to(ROOT / base).as_posix()
            target = '/'.join(part for part in (prefix, rel) if part)
            mode = 0o755 if target.startswith('etc/uci-defaults/') or target.endswith('.sh') else 0o644

            data = path.read_bytes()
            if target.startswith('etc/uci-defaults/') or target.endswith(('.sh', '.js', '.json')):
                data = data.replace(b'\r\n', b'\n')

            files.append((target, data, mode))

    files.sort(key=lambda item: item[0])
    return files


def parent_dirs(files):
    dirs = set()

    for target, _, _ in files:
        parts = target.split('/')[:-1]
        for i in range(1, len(parts) + 1):
            dirs.add('/'.join(parts[:i]))

    return sorted(dirs)


class TarWriter(tarfile.TarFile):
    """TarFile without the 10240-byte record padding added by close()."""

    def close(self):
        if self.closed:
            return

        self.closed = True
        try:
            if self.mode in ('a', 'w', 'x'):
                self.fileobj.write(tarfile.NUL * (tarfile.BLOCKSIZE * 2))
                self.offset += tarfile.BLOCKSIZE * 2
        finally:
            if not self._extfileobj:
                self.fileobj.close()


def add_dir(tf, name, mode, epoch):
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.size = 0
    info.mode = mode
    info.uid = 0
    info.gid = 0
    info.uname = 'root'
    info.gname = 'root'
    info.mtime = epoch
    tf.addfile(info)


def add_file(tf, name, data, mode, epoch, checksum=False):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.uid = 0
    info.gid = 0
    info.uname = 'root'
    info.gname = 'root'
    info.mtime = epoch
    if checksum:
        # apk v2 requires per-file checksums in a pax header; apk-tools 3.x
        # refuses files without them ("file format is obsolete").
        info.pax_headers = {'APK-TOOLS.checksum.SHA1': hashlib.sha1(data).hexdigest()}
    tf.addfile(info, io.BytesIO(data))


def tar_bytes(files, prefix, include_root, trailer, epoch, checksum=False):
    buf = io.BytesIO()
    fmt = tarfile.PAX_FORMAT if checksum else tarfile.GNU_FORMAT

    with TarWriter(fileobj=buf, mode='w', format=fmt) as tf:
        if include_root:
            add_dir(tf, './', 0o755, epoch)

        for directory in parent_dirs(files):
            add_dir(tf, prefix + directory + '/', 0o755, epoch)

        for name, data, mode in files:
            add_file(tf, prefix + name, data, mode, epoch, checksum)

    data = buf.getvalue()

    if not trailer:
        if not data.endswith(b'\0' * 1024):
            raise RuntimeError('tar writer did not produce the expected trailer')
        data = data[:-1024]

    return data


def gzip_bytes(data):
    return gzip.compress(data, compresslevel=9, mtime=0)


def split_gzip_members(data):
    members = []
    raws = []
    rest = data

    while rest:
        decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
        out = decompressor.decompress(rest)
        out += decompressor.flush()
        members.append(out)
        raws.append(rest[:len(rest) - len(decompressor.unused_data)])
        rest = decompressor.unused_data

    return members, raws


def installed_size(files):
    return sum(len(data) for _, data, _ in files)


def ipk_control(version, epoch, size_kb):
    epoch_line = f'SourceDateEpoch: {epoch}\n' if epoch else ''

    return (
        'Package: %s\n'
        'Version: %s\n'
        'Depends: libc, zerotier, luci-base\n'
        'Source: package/%s\n'
        'SourceName: %s\n'
        'License: %s\n'
        'Section: luci\n'
        '%s'
        'URL: %s\n'
        'Maintainer: %s\n'
        'Architecture: all\n'
        'Installed-Size: %d\n'
        'Description: %s\n'
    ) % (PACKAGE, version, PACKAGE, PACKAGE, LICENSE, epoch_line, URL, MAINTAINER, size_kb, TITLE)


def apk_pkginfo(version, epoch, size, datahash):
    return (
        '# Generated by %s package build script\n'
        'pkgname = %s\n'
        'pkgver = %s\n'
        'pkgdesc = %s\n'
        'url = %s\n'
        'builddate = %d\n'
        'packager = %s\n'
        'size = %d\n'
        'arch = noarch\n'
        'origin = %s\n'
        'license = %s\n'
        'depend = zerotier\n'
        'depend = luci-base\n'
        'datahash = %s\n'
    ) % (PACKAGE, PACKAGE, version, TITLE, URL, epoch, MAINTAINER, size, PACKAGE, LICENSE, datahash)


def build_ipk(files, version, epoch):
    data_tar = tar_bytes(files, './', True, True, epoch)
    data_gz = gzip_bytes(data_tar)

    control_files = [
        ('control', ipk_control(version, epoch, max(1, (installed_size(files) + 1023) // 1024)).encode(), 0o644),
        ('postinst', POSTINST, 0o755),
        ('postinst-pkg', POSTINST_PKG, 0o755),
        ('prerm', PRERM, 0o755),
    ]
    control_tar = tar_bytes(control_files, './', True, True, epoch)
    control_gz = gzip_bytes(control_tar)

    outer_files = [
        ('debian-binary', b'2.0\n', 0o644),
        ('data.tar.gz', data_gz, 0o644),
        ('control.tar.gz', control_gz, 0o644),
    ]
    outer_tar = tar_bytes(outer_files, './', False, True, epoch)

    return gzip_bytes(outer_tar)


def load_key(keydir, sign):
    if not sign:
        return None

    if not HAVE_CRYPTO:
        raise RuntimeError('the cryptography module is not installed; use --no-sign or "pip install cryptography"')

    keydir.mkdir(parents=True, exist_ok=True)
    private_path = keydir / (PACKAGE + '.rsa')
    public_path = keydir / (PACKAGE + '.rsa.pub')

    if private_path.exists():
        private_key = serialization.load_pem_private_key(private_path.read_bytes(), password=None)
    else:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        private_path.write_bytes(private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()
        ))
        try:
            private_path.chmod(0o600)
        except OSError:
            pass

    public_path.write_bytes(private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo
    ))

    return private_key


def build_apk(files, version, epoch, private_key):
    data_tar = tar_bytes(files, '', False, True, epoch, True)
    data_gz = gzip_bytes(data_tar)
    datahash = hashlib.sha256(data_gz).hexdigest()

    pkginfo = apk_pkginfo(version, epoch, installed_size(files), datahash).encode()
    control_files = [
        ('.PKGINFO', pkginfo, 0o644),
        ('.post-install', APK_POSTINST, 0o755),
    ]
    control_tar = tar_bytes(control_files, '', False, False, epoch)
    control_gz = gzip_bytes(control_tar)

    if private_key is None:
        return control_gz + data_gz

    signature = private_key.sign(control_gz, padding.PKCS1v15(), hashes.SHA256())
    signature_name = '.SIGN.RSA256.%s.rsa.pub' % PACKAGE
    signature_tar = tar_bytes([(signature_name, signature, 0o644)], '', False, False, epoch)
    signature_gz = gzip_bytes(signature_tar)

    return signature_gz + control_gz + data_gz


def verify_ipk(data, version):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as outer:
        names = outer.getnames()
        for required in ('./debian-binary', './control.tar.gz', './data.tar.gz'):
            if required not in names:
                raise RuntimeError('ipk is missing ' + required)

        if outer.extractfile('./debian-binary').read() != b'2.0\n':
            raise RuntimeError('bad debian-binary')

        control_gz = outer.extractfile('./control.tar.gz').read()
        data_gz = outer.extractfile('./data.tar.gz').read()

    with tarfile.open(fileobj=io.BytesIO(control_gz), mode='r:gz') as control:
        fields = control.extractfile('./control').read().decode()

    with tarfile.open(fileobj=io.BytesIO(data_gz), mode='r:gz') as payload:
        payload_names = payload.getnames()

    if ('Package: %s\n' % PACKAGE) not in fields:
        raise RuntimeError('control has no Package field')
    if ('Version: %s\n' % version) not in fields:
        raise RuntimeError('control has an unexpected version')

    return payload_names


def verify_apk(data, version, public_key):
    members, raws = split_gzip_members(data)

    if len(members) == 3:
        with tarfile.open(fileobj=io.BytesIO(members[0]), mode='r:') as signature_tar:
            signature_name = signature_tar.getnames()[0]
            signature = signature_tar.extractfile(signature_name).read()

        if public_key is None:
            raise RuntimeError('apk is signed but no public key is available')

        public_key.verify(signature, raws[1], padding.PKCS1v15(), hashes.SHA256())
        control_index = 1
    elif len(members) == 2:
        control_index = 0
    else:
        raise RuntimeError('unexpected number of gzip members in apk: %d' % len(members))

    with tarfile.open(fileobj=io.BytesIO(members[control_index]), mode='r:') as control:
        pkginfo = control.extractfile('.PKGINFO').read().decode()
        control_names = control.getnames()

    with tarfile.open(fileobj=io.BytesIO(members[-1]), mode='r:') as payload:
        payload_names = payload.getnames()
        payload_members = payload.getmembers()

    missing = [
        item.name for item in payload_members
        if item.isreg() and 'APK-TOOLS.checksum.SHA1' not in item.pax_headers
    ]
    if missing:
        raise RuntimeError('apk files without embedded checksum: %s' % ', '.join(missing))

    fields = {}
    for line in pkginfo.splitlines():
        if ' = ' in line:
            key, value = line.split(' = ', 1)
            fields.setdefault(key, []).append(value)

    if fields.get('pkgname') != [PACKAGE]:
        raise RuntimeError('bad apk pkgname')
    if fields.get('pkgver') != [version]:
        raise RuntimeError('bad apk pkgver')
    if fields.get('datahash', [None])[0] != hashlib.sha256(raws[-1]).hexdigest():
        raise RuntimeError('apk datahash mismatch')

    return control_names + payload_names


def main():
    parser = argparse.ArgumentParser(description='Build luci-app-zerotier ipk and apk packages')
    parser.add_argument('--version', default='2026.11.28-r4', help='package version (default: 2026.11.28-r4)')
    parser.add_argument('--outdir', default='dist', help='output directory (default: dist)')
    parser.add_argument('--keydir', default='keys', help='signing key directory (default: keys)')
    parser.add_argument('--epoch', type=int, default=int(os.environ.get('SOURCE_DATE_EPOCH', time.time())),
                        help='build timestamp (default: SOURCE_DATE_EPOCH or now)')
    parser.add_argument('--no-sign', action='store_true', help='do not sign the apk')
    args = parser.parse_args()

    sign = not args.no_sign
    if sign and not HAVE_CRYPTO:
        print('warning: cryptography is not installed, building an unsigned apk', file=sys.stderr)
        sign = False

    outdir = (ROOT / args.outdir).resolve()
    keydir = (ROOT / args.keydir).resolve()
    outdir.mkdir(parents=True, exist_ok=True)

    files = collect_files()
    if not files:
        raise SystemExit('no package files found')

    private_key = load_key(keydir, sign)
    public_key = private_key.public_key() if private_key else None

    ipk = build_ipk(files, args.version, args.epoch)
    apk = build_apk(files, args.version, args.epoch, private_key)

    ipk_name = '%s_%s_all.ipk' % (PACKAGE, args.version)
    apk_name = '%s-%s.apk' % (PACKAGE, args.version)

    (outdir / ipk_name).write_bytes(ipk)
    (outdir / apk_name).write_bytes(apk)

    ipk_files = verify_ipk(ipk, args.version)
    apk_files = verify_apk(apk, args.version, public_key)

    if private_key:
        (outdir / (PACKAGE + '.rsa.pub')).write_bytes((keydir / (PACKAGE + '.rsa.pub')).read_bytes())

    print('files in package:')
    for name in sorted(set(ipk_files)):
        display = name[2:] if name.startswith('./') else name
        if display:
            print('  ' + display)

    print('\nbuilt:')
    for path in (outdir / ipk_name, outdir / apk_name):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        print('  %s  %d bytes  sha256=%s' % (path, path.stat().st_size, digest))

    print('\napk entries: %d, signed: %s' % (len(apk_files), 'yes' if private_key else 'no'))

    if private_key:
        print('\npublic key: %s' % (outdir / (PACKAGE + '.rsa.pub')))
        print('install it on the router before "apk add": /etc/apk/keys/%s.rsa.pub' % PACKAGE)
    else:
        print('\nunsigned apk: install with "apk add --allow-untrusted <file>.apk"')

    return 0


if __name__ == '__main__':
    sys.exit(main())
