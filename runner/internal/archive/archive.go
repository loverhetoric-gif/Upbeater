// Package archive は成果物・キャッシュを tar.gz にまとめ、安全に展開する。
// 展開では、決めた置き場所の外へ書き出すもの（絶対パス・..・外を指すシンボリックリンク）を拒否する。
package archive

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Entry はまとめる対象。Name は書庫の中での名前（先頭の区切りで置き場所を選ぶ。例：work/node_modules）。
type Entry struct {
	Name string
	Path string
}

// Create は entries を tar.gz にして w に書く。存在しないものは飛ばし、まとめた数を返す。
func Create(w io.Writer, entries []Entry) (int, error) {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	n := 0
	for _, e := range entries {
		if _, err := os.Lstat(e.Path); err != nil {
			continue
		}
		err := filepath.WalkDir(e.Path, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(e.Path, p)
			name := path.Join(e.Name, filepath.ToSlash(rel))
			info, err := d.Info()
			if err != nil {
				return err
			}
			link := ""
			if info.Mode()&fs.ModeSymlink != 0 {
				if link, err = os.Readlink(p); err != nil {
					return err
				}
			} else if !info.Mode().IsRegular() && !info.IsDir() {
				return nil // 名前付きパイプなどは含めない
			}
			hdr, err := tar.FileInfoHeader(info, link)
			if err != nil {
				return err
			}
			hdr.Name = name
			if info.IsDir() {
				hdr.Name += "/"
			}
			hdr.Uname, hdr.Gname, hdr.Uid, hdr.Gid = "", "", 0, 0
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			if info.Mode().IsRegular() {
				f, err := os.Open(p)
				if err != nil {
					return err
				}
				_, err = io.Copy(tw, f)
				f.Close()
				if err != nil {
					return err
				}
				n++
			}
			return nil
		})
		if err != nil {
			return n, err
		}
	}
	if err := tw.Close(); err != nil {
		return n, err
	}
	return n, gz.Close()
}

func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// Extract は tar.gz を展開する。roots は書庫の名前の先頭（例："work"）→ 置き場所のディレクトリ。
func Extract(r io.Reader, roots map[string]string) (int, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return 0, err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	resolved := map[string]string{}
	for k, v := range roots {
		if err := os.MkdirAll(v, 0o755); err != nil {
			return 0, err
		}
		real, err := filepath.EvalSymlinks(v)
		if err != nil {
			return 0, err
		}
		resolved[k] = real
	}
	n := 0
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return n, nil
		}
		if err != nil {
			return n, err
		}
		name := path.Clean(strings.TrimSuffix(hdr.Name, "/"))
		if path.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") || strings.Contains(name, "/../") {
			return n, fmt.Errorf("書庫に置き場所の外を指す名前があります：%s", hdr.Name)
		}
		top, rest, _ := strings.Cut(name, "/")
		root, ok := resolved[top]
		if !ok {
			return n, fmt.Errorf("書庫に知らない置き場所があります：%s", hdr.Name)
		}
		dest := filepath.Join(root, filepath.FromSlash(rest))
		if !within(root, dest) {
			return n, fmt.Errorf("書庫に置き場所の外を指す名前があります：%s", hdr.Name)
		}
		// 途中のディレクトリがシンボリックリンクで外を指していないか
		parent := filepath.Dir(dest)
		if err := os.MkdirAll(parent, 0o755); err != nil {
			return n, err
		}
		if real, err := filepath.EvalSymlinks(parent); err != nil || !within(root, real) {
			return n, fmt.Errorf("書庫の展開先が置き場所の外を指しています：%s", hdr.Name)
		}
		mode := os.FileMode(hdr.Mode).Perm()
		switch hdr.Typeflag {
		case tar.TypeDir:
			if rest == "" {
				continue
			}
			if err := os.MkdirAll(dest, mode|0o700); err != nil {
				return n, err
			}
		case tar.TypeReg:
			_ = os.Remove(dest) // 既存のシンボリックリンクを通して書かない
			f, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode|0o600)
			if err != nil {
				return n, err
			}
			_, err = io.Copy(f, tr)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return n, err
			}
			n++
		case tar.TypeSymlink:
			target := hdr.Linkname
			abs := target
			if !filepath.IsAbs(target) {
				abs = filepath.Join(filepath.Dir(dest), target)
			}
			if filepath.IsAbs(target) || !within(root, abs) {
				return n, fmt.Errorf("書庫に置き場所の外を指すリンクがあります：%s → %s", hdr.Name, target)
			}
			_ = os.Remove(dest)
			if err := os.Symlink(target, dest); err != nil {
				return n, err
			}
		default:
			// ハードリンク・デバイスなどは展開しない
		}
	}
}
