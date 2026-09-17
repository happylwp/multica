package dingtalk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// fileParam is the msgParam payload for a sampleFile message.
type fileParam struct {
	MediaID  string `json:"mediaId"`
	FileName string `json:"fileName"`
	FileType string `json:"fileType"`
}

// sendFile uploads bytes via the robot media API and delivers them as a
// sampleFile message. A 401 on either hop triggers one token refresh and retry.
func (s *sender) sendFile(ctx context.Context, target sendTarget, filename, fileType string, data []byte) (string, error) {
	if len(data) == 0 {
		return "", errors.New("dingtalk: empty file")
	}
	mediaID, err := s.uploadMedia(ctx, filename, data)
	if err != nil {
		return "", err
	}
	return s.sendSampleFile(ctx, target, filename, fileType, mediaID)
}

func (s *sender) sendSampleFile(ctx context.Context, target sendTarget, filename, fileType, mediaID string) (string, error) {
	if strings.TrimSpace(fileType) == "" {
		fileType = "file"
	}
	param, err := json.Marshal(fileParam{
		MediaID:  mediaID,
		FileName: filename,
		FileType: fileType,
	})
	if err != nil {
		return "", fmt.Errorf("marshal file msgParam: %w", err)
	}
	return s.sendOneKeyed(ctx, target, msgKeyFile, string(param))
}

func (s *sender) uploadMedia(ctx context.Context, filename string, data []byte) (string, error) {
	for attempt := 0; attempt < 2; attempt++ {
		token, err := s.client.accessToken(ctx, s.appKey, s.appSecret)
		if err != nil {
			return "", fmt.Errorf("access token: %w", err)
		}
		mediaID, err := s.client.uploadRobotMedia(ctx, token, s.robotCode, filename, data)
		if err == nil {
			return mediaID, nil
		}
		if errors.Is(err, errUnauthorized) && attempt == 0 {
			s.client.invalidate(s.appKey)
			continue
		}
		return "", err
	}
	return "", errUnauthorized
}
