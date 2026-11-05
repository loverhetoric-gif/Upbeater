// Package hub は Hub の Runner 用 API（hub/src/routes/runner.ts）を呼ぶ。
// Runner から Hub へ取りに行く方式で、Runner 側に受け口は開けない。
package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// JobTokenHeader はジョブトークンを送るヘッダー。
const JobTokenHeader = "x-upbeater-job-token"

// Error は Hub が返した誤り。
type Error struct {
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	if e.Message != "" && e.Message != e.Code {
		return fmt.Sprintf("Hub が %d を返しました（%s：%s）", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("Hub が %d を返しました（%s）", e.Status, e.Code)
}

// Retryable は時間をおけば通りうる誤りか（通信の失敗・5xx・429）。
func Retryable(err error) bool {
	var he *Error
	if errors.As(err, &he) {
		return he.Status >= 500 || he.Status == 429
	}
	return err != nil && !errors.Is(err, context.Canceled)
}

// IsStale は、このジョブが別の実行に移った（ジョブトークンが古い）ことを示す誤りか。
func IsStale(err error) bool {
	var he *Error
	return errors.As(err, &he) && he.Status == 409 && he.Code == "stale_job"
}

// IsUnauthorized は Runner トークンが無効になったことを示すか。
func IsUnauthorized(err error) bool {
	var he *Error
	return errors.As(err, &he) && he.Status == 401
}

// Client は Hub への接続。
type Client struct {
	Base  string
	Token string
	HTTP  *http.Client
}

// New は Client を作る。
func New(base, token string) *Client {
	return &Client{Base: base, Token: token, HTTP: &http.Client{Timeout: 60 * time.Second}}
}

func (c *Client) do(ctx context.Context, method, path string, jobToken string, body, out any) (int, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, rd)
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("authorization", "Bearer "+c.Token)
	}
	if jobToken != "" {
		req.Header.Set(JobTokenHeader, jobToken)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return res.StatusCode, err
	}
	if res.StatusCode >= 400 {
		return res.StatusCode, parseError(res, data)
	}
	if out != nil && res.StatusCode != http.StatusNoContent && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return res.StatusCode, fmt.Errorf("Hub の応答を読めません：%w", err)
		}
	}
	return res.StatusCode, nil
}

func parseError(res *http.Response, data []byte) error {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(data, &e)
	he := &Error{Status: res.StatusCode, Code: e.Error, Message: e.Message}
	if he.Code == "" {
		he.Code = http.StatusText(res.StatusCode)
	}
	if s, err := strconv.Atoi(res.Header.Get("retry-after")); err == nil && s > 0 {
		he.RetryAfter = time.Duration(s) * time.Second
	}
	return he
}

// RegisterResult は登録の結果。
type RegisterResult struct {
	RunnerID string   `json:"runner_id"`
	Token    string   `json:"token"`
	Labels   []string `json:"labels"`
}

// Register は一回限りの登録コードで Runner を登録する。
func (c *Client) Register(ctx context.Context, code, name string, labels []string) (*RegisterResult, error) {
	var r RegisterResult
	_, err := c.do(ctx, "POST", "/v1/runners/register", "", map[string]any{"code": code, "name": name, "labels": labels}, &r)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// Step は定義ファイルの手順（Hub の Step 型と同じ形）。
type Step struct {
	Kind             string            `json:"kind"`
	Name             string            `json:"name,omitempty"`
	Run              string            `json:"run,omitempty"`
	Uses             string            `json:"uses,omitempty"`
	With             map[string]string `json:"with,omitempty"`
	Env              map[string]string `json:"env,omitempty"`
	If               string            `json:"if,omitempty"`
	WorkingDirectory string            `json:"workingDirectory,omitempty"`
	Timeout          int               `json:"timeout,omitempty"`
	ContinueOnError  bool              `json:"continueOnError,omitempty"`
	Platform         string            `json:"platform,omitempty"`
	File             string            `json:"file,omitempty"`
}

// Artifact は成果物の指定。
type Artifact struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// Cache はキャッシュの指定。
type Cache struct {
	Key   string   `json:"key"`
	Paths []string `json:"paths"`
}

// Job は受け取ったジョブ。
type Job struct {
	Job struct {
		ID             string         `json:"id"`
		Attempt        int            `json:"attempt"`
		Name           string         `json:"name"`
		JobKey         string         `json:"job_key"`
		RunID          string         `json:"run_id"`
		RunNumber      int            `json:"run_number"`
		Matrix         map[string]any `json:"matrix"`
		TimeoutMinutes int            `json:"timeout_minutes"`
		Rerunnable     bool           `json:"rerunnable"`
	} `json:"job"`
	JobToken string `json:"job_token"`
	Repo     struct {
		FullName   string `json:"full_name"`
		CloneURL   string `json:"clone_url"`
		SHA        string `json:"sha"`
		Ref        string `json:"ref"`
		AuthHeader string `json:"auth_header"`
	} `json:"repo"`
	Event struct {
		Kind   string         `json:"kind"`
		Branch string         `json:"branch"`
		Actor  string         `json:"actor"`
		Inputs map[string]any `json:"inputs"`
	} `json:"event"`
	Steps               []Step            `json:"steps"`
	Env                 map[string]string `json:"env"`
	Secrets             map[string]string `json:"secrets"`
	SecretsWithheld     bool              `json:"secrets_withheld"`
	Artifacts           []Artifact        `json:"artifacts"`
	Cache               *Cache            `json:"cache"`
	HeartbeatIntervalMS int               `json:"heartbeat_interval_ms"`
}

// Claim はラベルに合うジョブを 1 件受け取る。無ければ nil。
func (c *Client) Claim(ctx context.Context, labels []string) (*Job, error) {
	var j Job
	st, err := c.do(ctx, "POST", "/v1/runners/claim", "", map[string]any{"labels": labels}, &j)
	if err != nil {
		return nil, err
	}
	if st == http.StatusNoContent {
		return nil, nil
	}
	return &j, nil
}

// HeartbeatResult は心拍の応答。Continue が false なら中断する。
type HeartbeatResult struct {
	Continue bool   `json:"continue"`
	Cancel   bool   `json:"cancel"`
	Status   string `json:"status"`
	Reason   string `json:"reason"`
}

func jobPath(id, what string) string { return "/v1/runners/jobs/" + url.PathEscape(id) + "/" + what }

// Heartbeat は心拍を送る。
func (c *Client) Heartbeat(ctx context.Context, jobID, jobToken string) (*HeartbeatResult, error) {
	var r HeartbeatResult
	if _, err := c.do(ctx, "POST", jobPath(jobID, "heartbeat"), jobToken, map[string]any{}, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// Chunk はログの断片。
type Chunk struct {
	Seq  int    `json:"seq"`
	Text string `json:"text"`
}

// LogsResult はログ送信の応答。
type LogsResult struct {
	ContiguousThrough int   `json:"contiguous_through"`
	Missing           []int `json:"missing"`
}

// Logs はログの断片を送る。
func (c *Client) Logs(ctx context.Context, jobID, jobToken string, chunks []Chunk, lastSeq int) (*LogsResult, error) {
	var r LogsResult
	if _, err := c.do(ctx, "POST", jobPath(jobID, "logs"), jobToken, map[string]any{"chunks": chunks, "last_seq": lastSeq}, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// StepStatus は手順の状態を送る。
func (c *Client) StepStatus(ctx context.Context, jobID, jobToken string, index int, name, status string, exitCode *int) error {
	body := map[string]any{"index": index, "name": name, "status": status}
	if exitCode != nil {
		body["exit_code"] = *exitCode
	}
	_, err := c.do(ctx, "POST", jobPath(jobID, "steps"), jobToken, body, nil)
	return err
}

// CompleteResult は終了の報告の応答。
type CompleteResult struct {
	Status  string `json:"status"`
	Missing []int  `json:"missing"`
}

// Complete は終了を報告する。conclusion は success・failure・cancelled。
func (c *Client) Complete(ctx context.Context, jobID, jobToken, conclusion, reason string, lastSeq int) (*CompleteResult, error) {
	var r CompleteResult
	body := map[string]any{"conclusion": conclusion, "last_seq": lastSeq}
	if reason != "" {
		body["reason"] = reason
	}
	if _, err := c.do(ctx, "POST", jobPath(jobID, "complete"), jobToken, body, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// BlobInfo は成果物・キャッシュの付帯情報。
type BlobInfo struct {
	SHA256   string
	Format   string // tar.gz または file
	Filename string
	Size     int64
}

// PutBlob は成果物（kind=artifacts）・キャッシュ（kind=cache）を送る。Hub は SHA-256 を確かめて保存する。
func (c *Client) PutBlob(ctx context.Context, jobID, jobToken, kind, name string, body io.Reader, info BlobInfo) error {
	req, err := http.NewRequestWithContext(ctx, "PUT", c.Base+jobPath(jobID, kind+"/"+url.PathEscape(name)), body)
	if err != nil {
		return err
	}
	req.ContentLength = info.Size
	req.Header.Set("content-type", "application/octet-stream")
	req.Header.Set("authorization", "Bearer "+c.Token)
	req.Header.Set(JobTokenHeader, jobToken)
	req.Header.Set("x-upbeater-sha256", info.SHA256)
	req.Header.Set("x-upbeater-format", info.Format)
	if info.Filename != "" {
		req.Header.Set("x-upbeater-filename", url.PathEscape(info.Filename))
	}
	// 大きなファイルの送信は時間がかかるため、全体の時間制限は付けない（ctx で止める）
	hc := *c.HTTP
	hc.Timeout = 0
	res, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 400 {
		return parseError(res, data)
	}
	return nil
}

// GetBlob は成果物・キャッシュを取り出す。無ければ (nil, nil, nil)。読み終えたら Close すること。
func (c *Client) GetBlob(ctx context.Context, jobID, jobToken, kind, name string) (io.ReadCloser, *BlobInfo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.Base+jobPath(jobID, kind+"/"+url.PathEscape(name)), nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("authorization", "Bearer "+c.Token)
	req.Header.Set(JobTokenHeader, jobToken)
	hc := *c.HTTP
	hc.Timeout = 0
	res, err := hc.Do(req)
	if err != nil {
		return nil, nil, err
	}
	if res.StatusCode == http.StatusNotFound {
		res.Body.Close()
		return nil, nil, nil
	}
	if res.StatusCode >= 400 {
		data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		res.Body.Close()
		return nil, nil, parseError(res, data)
	}
	fn, _ := url.PathUnescape(res.Header.Get("x-upbeater-filename"))
	return res.Body, &BlobInfo{SHA256: res.Header.Get("x-upbeater-sha256"), Format: res.Header.Get("x-upbeater-format"), Filename: fn, Size: res.ContentLength}, nil
}
