/// リポジトリのバッジ（AppBadge）の見た目を決める純粋関数群。
/// 同じ repo は常に同じ色・同じモノグラムになる（決定的）。テスト対象はここ
library;

/// `owner/name` から表示用の短い名前を取り出す
String repoShortName(String repo) {
  final trimmed = repo.trim();
  final i = trimmed.lastIndexOf('/');
  if (i < 0 || i == trimmed.length - 1) return trimmed;
  return trimmed.substring(i + 1);
}

/// モノグラム（最大2文字）。区切り記号を除いた先頭2文字で、1文字目だけ大文字にする
/// 例：Upbeater → Up、PLEATS-web → PL、loverhetoric-gif/Upbeater → Up
String repoMonogram(String repo) {
  final letters = repoShortName(repo).replaceAll(RegExp(r'[^A-Za-z0-9]'), '');
  if (letters.isEmpty) return '?';
  if (letters.length == 1) return letters.toUpperCase();
  return letters[0].toUpperCase() + letters[1];
}

/// 名前のハッシュから色相（0〜360）を決める。名前が違えば色が十分に散るよう、
/// 文字列全体に位置の重みを掛けた単純なハッシュを使う
double repoHue(String repo) {
  var hash = 0;
  final s = repo.trim().toLowerCase();
  for (var i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.codeUnitAt(i)) & 0x7fffffff;
  }
  return (hash % 360).toDouble();
}
